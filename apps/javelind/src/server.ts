import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CommitSummary,
  SearchResponse,
  FetchObjectsResponse,
  ListRefsResponse,
  ListReposResponse,
  JrpErrorCode,
  RefUpdate,
  RefUpdateResult,
  RepoInfo,
  SerializedObject,
  UpdateRefsResponse,
  UploadObjectsResponse,
} from "@javelin/protocol";
import { isObjectId, objectId, type ObjectId } from "@javelin/protocol";
import { indexCommit, searchCode, searchHistory, searchProvenance } from "@javelin/search";
import { encodeObject, hashEncoding, Repository, type StoredObject } from "@javelin/vcs";

export interface JavelindOptions {
  port?: number;
  root: string;
  /** Empty or undefined disables auth for local development. */
  token?: string;
}

export interface JavelindServer {
  port: number;
  hostname: string;
  stop(): void;
}

interface RepoMeta {
  name: string;
  createdAt: string;
  defaultBranch: string;
  description?: string;
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_NAME = /^refs\/[A-Za-z0-9._/-]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class HttpError extends Error {
  constructor(readonly status: number, readonly code: JrpErrorCode, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message } }, e.status);
  const message = e instanceof Error ? e.message : String(e);
  return json({ error: { code: "internal", message } }, 500);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "bad_request", "request body must be a JSON object");
    }
    return body as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "bad_request", "invalid JSON body");
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new HttpError(400, "bad_request", `missing or invalid field: ${field}`);
  }
  return v;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${crypto.randomUUID()}`);
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

type SearchKind = "code" | "history" | "provenance";

async function dispatchSearch(
  repo: Repository,
  kind: SearchKind,
  query: string,
  limit: number,
  head: ObjectId,
): Promise<SearchResponse["hits"]> {
  switch (kind) {
    case "history":
      return searchHistory(repo, query, limit);
    case "provenance":
      return searchProvenance(repo, query, limit);
    default:
      return searchCode(repo, query, limit, head);
  }
}

/** Serializes ref updates per repo so CAS read-then-write cannot interleave. */class RepoLocks {
  private locks = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    this.locks.set(key, result.catch(() => {}));
    return result;
  }
}

export function createServer(opts: JavelindOptions): JavelindServer {
  const root = opts.root;
  mkdirSync(root, { recursive: true });
  const locks = new RepoLocks();
  const pendingIndex = new Map<string, Promise<void>>();

  const repoDir = (name: string) => join(root, name);
  const metaPath = (name: string) => join(root, name, ".javelin", "meta.json");

  async function readMeta(name: string): Promise<RepoMeta | null> {
    try {
      return JSON.parse(await readFile(metaPath(name), "utf8")) as RepoMeta;
    } catch {
      return null;
    }
  }

  async function openRepo(name: string): Promise<Repository> {
    if (!REPO_NAME.test(name) || !(await readMeta(name))) {
      throw new HttpError(404, "not_found", `repository not found: ${name}`);
    }
    return Repository.open(repoDir(name));
  }

  function toStored(s: SerializedObject): StoredObject {
    if (s.kind === "blob") return { kind: "blob", data: encoder.encode(s.data) };
    return s.object as StoredObject;
  }

  function toWire(id: ObjectId, obj: StoredObject): SerializedObject {
    if (obj.kind === "blob") return { id, kind: "blob", data: decoder.decode(obj.data) };
    return { id, kind: obj.kind, object: obj } as SerializedObject;
  }

  async function isFastForward(repo: Repository, oldId: ObjectId, newId: ObjectId): Promise<boolean> {
    const seen = new Set<string>();
    const queue = [newId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (id === oldId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const commit = await repo.objects.read(id);
      if (!commit || commit.kind !== "commit") return false;
      queue.push(...commit.parents);
    }
    return false;
  }

  async function applyRefUpdate(repo: Repository, u: RefUpdate): Promise<RefUpdateResult> {
    const ref = u.ref;
    if (typeof ref !== "string" || !REF_NAME.test(ref) || ref.includes("..")) {
      return { ref, ok: false, reason: "policy-rejected", detail: `invalid ref name: ${String(ref)}` };
    }
    if (u.expectedOld !== null && !isObjectId(u.expectedOld)) {
      return { ref, ok: false, reason: "policy-rejected", detail: "expectedOld must be null or a hex object id" };
    }
    if (u.new !== null && !isObjectId(u.new)) {
      return { ref, ok: false, reason: "policy-rejected", detail: "new must be null or a hex object id" };
    }
    const newId = u.new ? objectId(u.new) : null;
    const current = await repo.refs.get(ref);
    if (current && newId && current !== newId && !(await isFastForward(repo, current, newId))) {
      return { ref, ok: false, reason: "non-fast-forward", detail: `${ref} is at ${current}` };
    }
    return repo.refs.set(ref, newId, u.expectedOld);
  }

  async function resolveHead(repo: Repository): Promise<ObjectId | null> {
    try {
      return await repo.resolveToCommit(await repo.currentBranch());
    } catch {
      return null;
    }
  }

  function commitSummary(id: ObjectId, commit: Extract<StoredObject, { kind: "commit" }>): CommitSummary {
    const summary: CommitSummary = {
      id,
      tree: commit.tree,
      parents: commit.parents,
      author: commit.author,
      message: commit.message,
    };
    if (commit.provenance) summary.provenance = commit.provenance;
    return summary;
  }

  async function handle(req: Request, url: URL): Promise<Response> {
    if (opts.token) {
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${opts.token}`) {
        throw new HttpError(401, "unauthorized", "missing or invalid bearer token");
      }
    }
    const seg = url.pathname.split("/").filter(Boolean);
    const method = req.method;

    if (seg[0] === "jrp" && seg[1] === "v1" && seg[2] === "repos" && seg.length === 3) {
      if (method === "POST") {
        const body = await readJsonBody(req);
        const name = requireString(body, "name");
        if (!REPO_NAME.test(name)) throw new HttpError(400, "bad_request", `invalid repository name: ${name}`);
        if (await readMeta(name)) throw new HttpError(409, "conflict", `repository already exists: ${name}`);
        const meta: RepoMeta = {
          name,
          createdAt: new Date().toISOString(),
          defaultBranch: typeof body.defaultBranch === "string" && body.defaultBranch ? body.defaultBranch : "main",
        };
        if (typeof body.description === "string") meta.description = body.description;
        await Repository.open(repoDir(name));
        await atomicWrite(metaPath(name), JSON.stringify(meta, null, 2) + "\n");
        return json(meta satisfies RepoInfo, 201);
      }
      if (method === "GET") {
        const repos: RepoInfo[] = [];
        let entries: string[] = [];
        try {
          entries = await readdir(root, { withFileTypes: true }).then((d) => d.filter((e) => e.isDirectory()).map((e) => e.name));
        } catch {}
        for (const name of entries.sort()) {
          const meta = await readMeta(name);
          if (meta) {
            repos.push({
              name: meta.name,
              createdAt: meta.createdAt,
              defaultBranch: meta.defaultBranch,
              ...(meta.description !== undefined ? { description: meta.description } : {}),
            });
          }
        }
        const res: ListReposResponse = { repos };
        return json(res);
      }
      throw new HttpError(400, "bad_request", `unsupported method ${method} for ${url.pathname}`);
    }

    if (seg[0] === "jrp" && seg[1] === "v1" && seg[2] === "repos" && seg.length >= 5) {
      const name = seg[3]!;
      const tail = seg.slice(4).join("/");

      if (tail === "refs" && method === "GET") {
        const repo = await openRepo(name);
        const refs = await repo.refs.list();
        const res: ListRefsResponse = { refs };
        return json(res);
      }

      if (tail === "objects/fetch" && method === "POST") {
        const repo = await openRepo(name);
        const body = await readJsonBody(req);
        const want = body.want;
        if (!Array.isArray(want)) throw new HttpError(400, "bad_request", "want must be an array of object ids");
        const objects: SerializedObject[] = [];
        for (const w of want) {
          if (typeof w !== "string" || !isObjectId(w)) {
            throw new HttpError(400, "bad_request", `invalid object id: ${String(w)}`);
          }
          const obj = await repo.objects.read(objectId(w));
          if (obj) objects.push(toWire(objectId(w), obj));
        }
        const res: FetchObjectsResponse = { objects };
        return json(res);
      }

      if (tail === "objects/upload" && method === "POST") {
        const repo = await openRepo(name);
        const body = await readJsonBody(req);
        const list = body.objects;
        if (!Array.isArray(list)) throw new HttpError(400, "bad_request", "objects must be an array");
        const accepted: ObjectId[] = [];
        const rejected: { id: ObjectId; reason: string }[] = [];
        for (const raw of list) {
          const s = raw as SerializedObject | undefined;
          if (!s || typeof s !== "object" || typeof s.id !== "string" || !isObjectId(s.id) || typeof s.kind !== "string") {
            rejected.push({ id: "0".repeat(64) as ObjectId, reason: "malformed object" });
            continue;
          }
          const id = objectId(s.id);
          const stored = toStored(s);
          const actual = await hashEncoding(encodeObject(stored));
          if (actual !== id) {
            rejected.push({ id, reason: `hash mismatch: content hashes to ${actual}` });
            continue;
          }
          await repo.objects.write(stored);
          accepted.push(id);
        }
        const res: UploadObjectsResponse = { accepted, rejected };
        return json(res);
      }

      if (tail === "refs/update" && method === "POST") {
        const repo = await openRepo(name);
        const body = await readJsonBody(req);
        const updates = body.updates;
        if (!Array.isArray(updates)) throw new HttpError(400, "bad_request", "updates must be an array");
        const results = await locks.run(`refs:${name}`, async () => {
          const out: RefUpdateResult[] = [];
          for (const u of updates as RefUpdate[]) {
            out.push(await applyRefUpdate(repo, u));
          }
          return out;
        });
        for (let i = 0; i < results.length; i++) {
          const newId = (updates as RefUpdate[])[i]!.new;
          if (results[i]!.ok && newId) {
            const task = indexCommit(repo, newId).catch(() => {}).then(() => {
              pendingIndex.delete(name);
            });
            pendingIndex.set(name, (pendingIndex.get(name) ?? Promise.resolve()).then(() => task));
          }
        }
        const res: UpdateRefsResponse = { results };
        return json(res);
      }

      if (tail === "log" && method === "POST") {
        const repo = await openRepo(name);
        const body = await readJsonBody(req);
        const start = requireString(body, "start");
        const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : 100;
        let entries;
        try {
          entries = await repo.log(start, limit);
        } catch {
          throw new HttpError(404, "not_found", `cannot resolve ${start} in ${name}`);
        }
        const commits: CommitSummary[] = entries.map((e) => commitSummary(e.id, e.commit));
        return json({ commits });
      }

      if (tail === "search" && method === "POST") {
        const repo = await openRepo(name);
        await pendingIndex.get(name);
        const body = await readJsonBody(req);
        const query = requireString(body, "query");
        const kind = body.kind === undefined || body.kind === "code" || body.kind === "history" || body.kind === "provenance" ? (body.kind ?? "code") : null;
        if (!kind) throw new HttpError(400, "bad_request", `invalid kind: ${String(body.kind)}`);
        const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : 20;
        let commitId: ObjectId | undefined;
        if (body.commitId !== undefined) {
          if (typeof body.commitId !== "string" || !isObjectId(body.commitId)) {
            throw new HttpError(400, "bad_request", "commitId must be a hex object id");
          }
          commitId = objectId(body.commitId);
        }
        const head = commitId ?? (await resolveHead(repo));
        const hits = head === null ? [] : await dispatchSearch(repo, kind, query, limit, head);
        const res: SearchResponse = { hits };
        return json(res);
      }
    }

    throw new HttpError(404, "not_found", `no route: ${method} ${url.pathname}`);
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch: async (req) => {
      try {
        return await handle(req, new URL(req.url));
      } catch (e) {
        return errorResponse(e);
      }
    },
  });

  return {
    port: server.port ?? 0,
    hostname: server.hostname ?? "localhost",
    stop: () => server.stop(true),
  };
}
