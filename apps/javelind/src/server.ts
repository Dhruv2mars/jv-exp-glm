import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type {
  BatchFetchResponse,
  BatchUploadResponse,
  ContributionListResponse,
  ContributionStatusUpdate,
  ContributionStatusUpdateResult,
  ContributionPutResponse,
  ContributionWithStatus,
  CreateRepoResponse,
  Cursor,
  ErrorCode,
  EvidenceQueryResponse,
  EvidencePutResponse,
  HeadKey,
  HeadUpdate,
  HeadUpdateResult,
  HeadsUpdateResponse,
  HealthzResponse,
  ListReposPage,
  ObjectId,
  ProvenancePutResponse,
  ProvenanceQueryResponse,
  ReadyzResponse,
  Repo,
  RepoSearchResponse,
  StateLogEntry,
  StatesLogResponse,
  WireObject,
} from "@javelin/protocol";
import {
  assertBatchWithinLimits,
  decodeBase64,
  DEFAULT_PAGE,
  encodeWireBlob,
  ERROR_HTTP_STATUS,
  isLegalContributionTransition,
  isObjectId,
  JRP_VERSION,
  JRP_VERSION_HEADER,
  LimitExceededError,
  MAX_BATCH_BYTES,
  MAX_OBJECT_BYTES,
  MAX_PAGE,
  objectId,
  RAW_CONTENT_TYPE,
} from "@javelin/protocol";
import { InvalidCursorError, searchCode, searchHistory, searchProvenance } from "@javelin/search";
import {
  encodeObject,
  hashEncoding,
  init as initRepository,
  openRepository,
  type ContributionMeta,
  type Repository,
  type StoredObject,
} from "@javelin/vcs";
import type {
  Contribution,
  ContributionEvent,
  ContributionStatus,
  EvidenceRecord,
  HeadsView,
  LayerRef,
  ProvenanceRecord,
} from "../../../packages/protocol/src/model";

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
  description?: string;
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LAYER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTRIBUTION_STATUSES: readonly ContributionStatus[] = ["open", "published", "discarded"];
const AGENT_ADAPTERS: readonly string[] = ["generic", "codex", "claude-code"];
const LOG_WALK_LIMIT = 10_000;
const STATUS_HTTP = ERROR_HTTP_STATUS;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly supported?: number[],
  ) {
    super(message);
  }
}

function notFound(message: string): HttpError {
  return new HttpError(STATUS_HTTP.not_found, "not_found", message);
}

function badRequest(message: string): HttpError {
  return new HttpError(STATUS_HTTP.bad_request, "bad_request", message);
}

function nowIso(): string {
  return new Date().toISOString();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const error = e.supported
      ? { code: e.code, message: e.message, supported: e.supported }
      : { code: e.code, message: e.message };
    return json({ error }, e.status);
  }
  if (e instanceof LimitExceededError) {
    return json({ error: { code: "payload_too_large", message: e.message } }, STATUS_HTTP.payload_too_large);
  }
  if (e instanceof InvalidCursorError) {
    return json({ error: { code: "bad_request", message: e.message } }, STATUS_HTTP.bad_request);
  }
  const message = e instanceof Error ? e.message : String(e);
  console.log(
    JSON.stringify({
      ts: nowIso(),
      level: "error",
      msg: "internal error",
      message,
      stack: e instanceof Error ? e.stack : undefined,
    }),
  );
  return json({ error: { code: "internal", message } }, STATUS_HTTP.internal);
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${crypto.randomUUID()}`);
  await Bun.write(tmp, contents);
  await rename(tmp, path);
}

/** Reads the request body, rejecting early when Content-Length exceeds MAX_BATCH_BYTES. */
async function readBodyBytes(req: Request): Promise<Uint8Array> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BATCH_BYTES) {
    throw new HttpError(STATUS_HTTP.payload_too_large, "payload_too_large", `request body exceeds ${MAX_BATCH_BYTES} bytes`);
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const read = await reader.read();
    if (read.done || read.value === undefined) break;
    total += read.value.byteLength;
    if (total > MAX_BATCH_BYTES) {
      await reader.cancel().catch(() => {});
      throw new HttpError(STATUS_HTTP.payload_too_large, "payload_too_large", `request body exceeds ${MAX_BATCH_BYTES} bytes`);
    }
    chunks.push(read.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await readBodyBytes(req)));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest("invalid JSON body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0) throw badRequest(`missing or invalid field: ${field}`);
  return v;
}

function requireObjectId(body: Record<string, unknown>, field: string): ObjectId {
  const v = body[field];
  if (typeof v !== "string" || !isObjectId(v)) throw badRequest(`${field} must be a hex object id`);
  return objectId(v);
}

function pageLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), MAX_PAGE);
  return DEFAULT_PAGE;
}

function encodeKeyCursor(k: string): string {
  return btoa(JSON.stringify({ k }));
}

function decodeKeyCursor(raw: string | undefined): { k: string } | null {
  if (raw === undefined || raw === "") return null;
  try {
    const parsed = JSON.parse(atob(raw)) as { k?: unknown };
    if (typeof parsed.k !== "string") throw new Error("bad cursor shape");
    return { k: parsed.k };
  } catch {
    throw badRequest("invalid cursor");
  }
}

/** Keyset pagination over a list sorted ascending by the key. */
function keyPage<T>(
  items: T[],
  keyOf: (item: T) => string,
  rawCursor: string | undefined,
  limit: number,
): { page: T[]; nextCursor?: string } {
  const cur = decodeKeyCursor(rawCursor);
  let start = 0;
  if (cur) {
    start = items.findIndex((item) => keyOf(item) > cur.k);
    if (start < 0) start = items.length;
  }
  const page = items.slice(start, start + limit);
  const last = page[page.length - 1];
  return {
    page,
    nextCursor: last !== undefined && start + limit < items.length ? encodeKeyCursor(keyOf(last)) : undefined,
  };
}

const WIRE_KINDS: readonly string[] = ["blob", "tree", "state", "provenance", "evidence", "contribution"];

function toWire(id: ObjectId, obj: StoredObject): WireObject {
  if (obj.kind === "blob") return encodeWireBlob(id, obj.data);
  return { id, kind: obj.kind, object: obj } as WireObject;
}

function toStored(raw: unknown): { id?: ObjectId; stored?: StoredObject; reason?: string } {
  if (typeof raw !== "object" || raw === null) return { reason: "malformed object" };
  const w = raw as { id?: unknown; kind?: unknown; data?: unknown; object?: unknown };
  if (typeof w.id !== "string" || !isObjectId(w.id)) return { reason: "invalid object id" };
  const id = objectId(w.id);
  if (typeof w.kind !== "string" || !WIRE_KINDS.includes(w.kind)) return { id, reason: `unknown kind: ${String(w.kind)}` };
  if (w.kind === "blob") {
    if (typeof w.data !== "string" || w.object !== undefined) return { id, reason: "blob requires data" };
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(w.data);
    } catch {
      return { id, reason: "invalid base64 data" };
    }
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      return { id, reason: `blob is ${bytes.byteLength} bytes; limit is ${MAX_OBJECT_BYTES} bytes` };
    }
    return { id, stored: { kind: "blob", data: bytes } };
  }
  if (typeof w.object !== "object" || w.object === null || w.data !== undefined) {
    return { id, reason: `${w.kind} requires object` };
  }
  const obj = w.object as StoredObject;
  if (obj.kind !== w.kind) return { id, reason: "object kind does not match wire kind" };
  return { id, stored: obj };
}

function worldIdFromRaw(raw: string | null): ObjectId | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed.value === "string" && isObjectId(parsed.value) ? objectId(parsed.value) : null;
  } catch {
    return null;
  }
}

function parseHeadUpdate(raw: unknown): HeadUpdate {
  if (typeof raw !== "object" || raw === null) throw badRequest("each update must be an object");
  const u = raw as { key?: unknown; expected?: unknown; next?: unknown };
  if (typeof u.key !== "string") throw badRequest("update.key must be a string");
  if (u.key !== "world" && !u.key.startsWith("layer/")) throw badRequest(`invalid head key: ${u.key}`);
  if (u.key.startsWith("layer/") && !LAYER_NAME.test(u.key.slice("layer/".length))) {
    throw badRequest(`invalid layer name: ${u.key.slice("layer/".length)}`);
  }
  for (const field of ["expected", "next"] as const) {
    const v = u[field];
    if (v !== null && (typeof v !== "string" || !isObjectId(v))) {
      throw badRequest(`update.${field} must be null or a hex object id`);
    }
  }
  return {
    key: u.key as HeadKey,
    expected: u.expected === null ? null : objectId(u.expected as string),
    next: u.next === null ? null : objectId(u.next as string),
  };
}

async function applyHeadUpdate(repo: Repository, u: HeadUpdate): Promise<HeadUpdateResult> {
  const mismatch = (): HeadUpdateResult => ({ key: u.key, ok: false, reason: "cas-mismatch" });
  if (u.key === "world") {
    const raw = await repo.meta.get("world");
    if (worldIdFromRaw(raw) !== u.expected) return mismatch();
    const moved = await repo.meta.compareAndSwap("world", raw, JSON.stringify({ value: u.next }));
    return moved.ok ? { key: u.key, ok: true } : mismatch();
  }
  const name = u.key.slice("layer/".length);
  const raw = await repo.meta.get(u.key);
  if (raw === null) {
    if (u.expected !== null) return { key: u.key, ok: false, reason: "not-found" };
    if (u.next === null) return { key: u.key, ok: true };
    const world = await repo.worldHead();
    if (!world) throw new HttpError(STATUS_HTTP.conflict, "conflict", "world head missing");
    const ref: LayerRef = { name, base: world, head: u.next, updatedAt: nowIso() };
    const created = await repo.meta.create(u.key, JSON.stringify(ref));
    return created ? { key: u.key, ok: true } : mismatch();
  }
  const ref = JSON.parse(raw) as LayerRef;
  if ((ref.head ?? null) !== u.expected) return mismatch();
  const nextRef: LayerRef = { ...ref, head: u.next, updatedAt: nowIso() };
  const moved = await repo.meta.compareAndSwap(u.key, raw, JSON.stringify(nextRef));
  return moved.ok ? { key: u.key, ok: true } : mismatch();
}

function parseProvenanceRecord(raw: unknown): ProvenanceRecord {
  if (typeof raw !== "object" || raw === null) throw badRequest("record must be an object");
  const r = raw as Record<string, unknown>;
  if (r.kind !== "provenance") throw badRequest("record.kind must be 'provenance'");
  if (!Array.isArray(r.states) || r.states.some((s) => typeof s !== "string" || !isObjectId(s))) {
    throw badRequest("record.states must be an array of hex object ids");
  }
  if (typeof r.agent !== "object" || r.agent === null) throw badRequest("record.agent is required");
  const agent = r.agent as { name?: unknown; adapter?: unknown };
  if (typeof agent.name !== "string" || typeof agent.adapter !== "string" || !AGENT_ADAPTERS.includes(agent.adapter)) {
    throw badRequest("record.agent must carry a name and a known adapter");
  }
  if (typeof r.startedAt !== "string") throw badRequest("record.startedAt must be a string");
  return r as unknown as ProvenanceRecord;
}

function parseEvidenceRecord(raw: unknown): EvidenceRecord {
  if (typeof raw !== "object" || raw === null) throw badRequest("record must be an object");
  const r = raw as Record<string, unknown>;
  if (r.kind !== "evidence") throw badRequest("record.kind must be 'evidence'");
  if (typeof r.state !== "string" || !isObjectId(r.state)) throw badRequest("record.state must be a hex object id");
  if (typeof r.rules !== "string") throw badRequest("record.rules must be a string");
  if (typeof r.at !== "string") throw badRequest("record.at must be a string");
  if (
    !Array.isArray(r.checks) ||
    r.checks.some(
      (c) =>
        typeof c !== "object" ||
        c === null ||
        typeof (c as { check?: unknown }).check !== "string" ||
        !["pass", "fail"].includes(String((c as { status?: unknown }).status)),
    )
  ) {
    throw badRequest("record.checks must be an array of {check, status}");
  }
  return r as unknown as EvidenceRecord;
}

function parseContribution(raw: unknown): Contribution {
  if (typeof raw !== "object" || raw === null) throw badRequest("contribution must be an object");
  const c = raw as Record<string, unknown>;
  if (c.kind !== "contribution") throw badRequest("contribution.kind must be 'contribution'");
  if (typeof c.layer !== "string" || !LAYER_NAME.test(c.layer)) throw badRequest("contribution.layer is invalid");
  for (const field of ["state", "base"] as const) {
    if (typeof c[field] !== "string" || !isObjectId(c[field])) throw badRequest(`contribution.${field} must be a hex object id`);
  }
  if (typeof c.title !== "string") throw badRequest("contribution.title must be a string");
  if (typeof c.author !== "object" || c.author === null) throw badRequest("contribution.author is required");
  const author = c.author as { name?: unknown; email?: unknown; time?: unknown };
  if (typeof author.name !== "string" || typeof author.email !== "string" || typeof author.time !== "string") {
    throw badRequest("contribution.author must carry name, email, and time");
  }
  if (typeof c.createdAt !== "string") throw badRequest("contribution.createdAt must be a string");
  return c as unknown as Contribution;
}

function isContributionStatus(v: unknown): v is ContributionStatus {
  return typeof v === "string" && (CONTRIBUTION_STATUSES as readonly string[]).includes(v);
}

function parseStatusUpdate(raw: unknown): ContributionStatusUpdate {
  if (typeof raw !== "object" || raw === null) throw badRequest("next must be an object");
  const n = raw as { status?: unknown; worldState?: unknown; note?: unknown };
  if (!isContributionStatus(n.status) || n.status === "open") throw badRequest("next.status must be 'published' or 'discarded'");
  if (n.note !== undefined && typeof n.note !== "string") throw badRequest("next.note must be a string");
  if (n.status === "published") {
    if (typeof n.worldState !== "string" || !isObjectId(n.worldState)) {
      throw badRequest("publishing requires next.worldState (a hex object id)");
    }
    return { status: "published", worldState: objectId(n.worldState), ...(n.note !== undefined ? { note: n.note } : {}) };
  }
  if (n.worldState !== undefined) throw badRequest("discarding must not carry next.worldState");
  return { status: "discarded", ...(n.note !== undefined ? { note: n.note } : {}) };
}

function logRequest(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: nowIso(), level: "info", msg: "request", ...entry }));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function createServer(opts: JavelindOptions): JavelindServer {
  const root = opts.root;
  mkdirSync(root, { recursive: true });

  const repoDir = (name: string) => join(root, name);
  const metaPath = (name: string) => join(root, name, ".javelin", "meta.json");

  async function readMeta(name: string): Promise<RepoMeta | null> {
    try {
      const raw = JSON.parse(await readFile(metaPath(name), "utf8")) as Partial<RepoMeta>;
      if (typeof raw.name !== "string" || typeof raw.createdAt !== "string") return null;
      return raw as RepoMeta;
    } catch {
      return null;
    }
  }

  async function openRepo(name: string): Promise<Repository> {
    if (!REPO_NAME.test(name) || !(await readMeta(name))) throw notFound(`repository not found: ${name}`);
    return openRepository(repoDir(name));
  }

  function wireRepo(meta: RepoMeta): Repo {
    return {
      name: meta.name,
      createdAt: meta.createdAt,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
    };
  }

  async function handleReposCreate(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    const name = requireString(body, "name");
    if (!REPO_NAME.test(name)) throw badRequest(`invalid repository name: ${name}`);
    if (await readMeta(name)) throw new HttpError(STATUS_HTTP.conflict, "conflict", `repository already exists: ${name}`);
    const meta: RepoMeta = { name, createdAt: nowIso() };
    if (typeof body.description === "string") meta.description = body.description;
    mkdirSync(repoDir(name), { recursive: true });
    await initRepository(repoDir(name));
    await atomicWrite(metaPath(name), JSON.stringify(meta, null, 2) + "\n");
    const res: CreateRepoResponse = { repo: wireRepo(meta) };
    return json(res);
  }

  async function handleReposList(url: URL): Promise<Response> {
    const limit = pageLimit(url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined);
    const metas: RepoMeta[] = [];
    let entries: string[] = [];
    try {
      entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      entries = [];
    }
    for (const name of entries.sort()) {
      const meta = await readMeta(name);
      if (meta) metas.push(meta);
    }
    const { page, nextCursor } = keyPage(metas, (m) => m.name, url.searchParams.get("cursor") ?? undefined, limit);
    const res: ListReposPage = {
      repos: page.map(wireRepo),
      ...(nextCursor !== undefined ? { nextCursor: nextCursor as Cursor } : {}),
    };
    return json(res);
  }

  async function handleHeadsGet(name: string): Promise<Response> {
    const repo = await openRepo(name);
    const view: HeadsView = { world: await repo.worldHead(), layers: await repo.layerList() };
    return json(view);
  }

  async function handleHeadsUpdate(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    if (!Array.isArray(body.updates)) throw badRequest("updates must be an array");
    const updates = body.updates.map(parseHeadUpdate);
    const results: HeadUpdateResult[] = [];
    for (const u of updates) results.push(await applyHeadUpdate(repo, u));
    const res: HeadsUpdateResponse = { results };
    return json(res);
  }

  async function handleBatchFetch(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    if (!Array.isArray(body.ids)) throw badRequest("ids must be an array");
    const objects: WireObject[] = [];
    const missing: ObjectId[] = [];
    for (const raw of body.ids) {
      if (typeof raw !== "string" || !isObjectId(raw)) throw badRequest(`invalid object id: ${String(raw)}`);
      const id = objectId(raw);
      const obj = await repo.objects.read(id);
      if (!obj) {
        missing.push(id);
        continue;
      }
      objects.push(toWire(id, obj));
    }
    assertBatchWithinLimits(objects);
    const res: BatchFetchResponse = { objects, missing };
    return json(res);
  }

  async function handleBatchUpload(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    if (!Array.isArray(body.objects)) throw badRequest("objects must be an array");
    const accepted: ObjectId[] = [];
    const rejected: { id: ObjectId; reason: string }[] = [];
    for (const raw of body.objects) {
      const parsed = toStored(raw);
      if (!parsed.id || !parsed.stored) {
        rejected.push({ id: objectId("0".repeat(64)), reason: parsed.reason ?? "malformed object" });
        continue;
      }
      const actual = await hashEncoding(encodeObject(parsed.stored));
      if (actual !== parsed.id) {
        rejected.push({ id: parsed.id, reason: "id does not match content" });
        continue;
      }
      await repo.objects.write(parsed.stored);
      accepted.push(parsed.id);
    }
    const res: BatchUploadResponse = { accepted, rejected };
    return json(res);
  }

  async function handleRawPut(repo: Repository, id: ObjectId, req: Request): Promise<Response> {
    if (!req.body) throw badRequest("request body required");
    const dest = join(repo.root, ".javelin", "raw", id.slice(0, 2), id.slice(2));
    const shard = dirname(dest);
    await mkdir(shard, { recursive: true });
    const tmp = join(shard, `.tmp-${crypto.randomUUID()}`);
    const hash = createHash("sha256");
    const writer = Bun.file(tmp).writer();
    try {
      const reader = req.body.getReader();
      for (;;) {
        const read = await reader.read();
        if (read.done || read.value === undefined) break;
        hash.update(read.value);
        writer.write(read.value);
      }
      await writer.end();
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    if (hash.digest("hex") !== id) {
      await rm(tmp, { force: true });
      throw badRequest("sha256 of body does not match object id");
    }
    await rename(tmp, dest);
    return new Response(null, { status: 200 });
  }

  async function handleRawGet(repo: Repository, id: ObjectId): Promise<Response> {
    const file = Bun.file(join(repo.root, ".javelin", "raw", id.slice(0, 2), id.slice(2)));
    if (!(await file.exists())) throw notFound(`object not found: ${id}`);
    return new Response(file, { headers: { "content-type": RAW_CONTENT_TYPE } });
  }

  async function handleStatesLog(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    const start = requireObjectId(body, "start");
    try {
      await repo.loadState(start);
    } catch {
      throw notFound(`unknown state: ${start}`);
    }
    const limit = pageLimit(body.limit);
    const walk: StateLogEntry[] = [];
    const seen = new Set<string>();
    const queue: ObjectId[] = [start];
    while (queue.length > 0 && walk.length < LOG_WALK_LIMIT) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const state = await repo.loadState(id);
      walk.push({ id, parents: state.parents, message: state.message, author: state.author });
      queue.unshift(...[...state.parents].reverse());
    }
    const cur = decodeKeyCursor(typeof body.cursor === "string" ? body.cursor : undefined);
    let begin = 0;
    if (cur) {
      const at = walk.findIndex((e) => e.id === cur.k);
      if (at < 0) throw badRequest("cursor does not match this log");
      begin = at + 1;
    }
    const entries = walk.slice(begin, begin + limit);
    const last = entries[entries.length - 1];
    const nextCursor = last !== undefined && begin + limit < walk.length ? encodeKeyCursor(last.id) : undefined;
    const res: StatesLogResponse = { entries, ...(nextCursor !== undefined ? { nextCursor: nextCursor as Cursor } : {}) };
    return json(res);
  }

  async function handleProvenancePut(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    const record = parseProvenanceRecord(body.record);
    const { id } = await repo.objects.write(record);
    const res: ProvenancePutResponse = { id };
    return json(res);
  }

  async function handleProvenanceQuery(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    let states: Set<string> | null = null;
    if (body.states !== undefined) {
      if (!Array.isArray(body.states) || body.states.some((s) => typeof s !== "string" || !isObjectId(s))) {
        throw badRequest("states must be an array of hex object ids");
      }
      states = new Set(body.states as string[]);
    }
    if (body.agent !== undefined && typeof body.agent !== "string") throw badRequest("agent must be a string");
    if (body.cursor !== undefined && typeof body.cursor !== "string") throw badRequest("cursor must be a string");
    const hits: { id: ObjectId; record: ProvenanceRecord }[] = [];
    for (const id of await repo.objects.list()) {
      const obj = await repo.objects.read(id);
      if (!obj || obj.kind !== "provenance") continue;
      if (states && !obj.states.some((s) => states.has(s))) continue;
      if (body.agent !== undefined && obj.agent.name !== body.agent && obj.agent.adapter !== body.agent) continue;
      hits.push({ id, record: obj });
    }
    hits.sort((a, b) => (a.id < b.id ? -1 : 1));
    const limit = pageLimit(body.limit);
    const { page, nextCursor } = keyPage(hits, (h) => h.id, body.cursor as string | undefined, limit);
    const res: ProvenanceQueryResponse = {
      records: page.map((h) => h.record),
      ...(nextCursor !== undefined ? { nextCursor: nextCursor as Cursor } : {}),
    };
    return json(res);
  }

  async function handleEvidencePut(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    const record = parseEvidenceRecord(body.record);
    const { id } = await repo.objects.write(record);
    const res: EvidencePutResponse = { id };
    return json(res);
  }

  async function handleEvidenceQuery(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    const state = requireObjectId(body, "state");
    if (body.rules !== undefined && typeof body.rules !== "string") throw badRequest("rules must be a string");
    const records = (await repo.evidenceFor(state))
      .filter((e) => body.rules === undefined || e.record.rules === body.rules)
      .map((e) => e.record);
    const res: EvidenceQueryResponse = { records };
    return json(res);
  }

  async function handleContributionCreate(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    const contribution = parseContribution(body.contribution);
    const { id } = await repo.objects.write(contribution);
    const meta: ContributionMeta = {
      contributionId: id,
      status: "open",
      events: [{ status: "open", at: nowIso() }],
    };
    await repo.meta.create(`contrib/${id}`, JSON.stringify(meta));
    const res: ContributionPutResponse = { id };
    return json(res);
  }

  async function handleContributionList(name: string, url: URL): Promise<Response> {
    const repo = await openRepo(name);
    const statusParam = url.searchParams.get("status");
    if (statusParam !== null && !isContributionStatus(statusParam)) throw badRequest(`invalid status: ${statusParam}`);
    const limit = pageLimit(url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined);
    const items: ContributionWithStatus[] = [];
    for (const key of await repo.meta.list("contrib/")) {
      const raw = await repo.meta.get(key);
      if (!raw) continue;
      const meta = JSON.parse(raw) as ContributionMeta;
      if (statusParam !== null && meta.status !== statusParam) continue;
      const id = objectId(key.slice("contrib/".length));
      const obj = await repo.objects.read(id);
      if (!obj || obj.kind !== "contribution") continue;
      items.push({ id, ...obj, status: meta.status });
    }
    items.sort((a, b) => (a.id < b.id ? -1 : 1));
    const { page, nextCursor } = keyPage(items, (c) => c.id, url.searchParams.get("cursor") ?? undefined, limit);
    const res: ContributionListResponse = {
      contributions: page,
      ...(nextCursor !== undefined ? { nextCursor: nextCursor as Cursor } : {}),
    };
    return json(res);
  }

  async function handleContributionStatus(name: string, idRaw: string, req: Request): Promise<Response> {
    if (!isObjectId(idRaw)) throw badRequest("invalid contribution id");
    const id = objectId(idRaw);
    const body = await readJsonBody(req);
    if (!isContributionStatus(body.expected)) throw badRequest("expected must be a contribution status");
    const next = parseStatusUpdate(body.next);
    const key = `contrib/${id}`;
    const repo = await openRepo(name);
    const raw = await repo.meta.get(key);
    if (raw === null) {
      const miss: ContributionStatusUpdateResult = { id, ok: false, reason: "not-found" };
      return json(miss);
    }
    const meta = JSON.parse(raw) as ContributionMeta;
    const fail = (reason: "cas-mismatch" | "illegal-transition"): Response => {
      const result: ContributionStatusUpdateResult = { id, ok: false, reason };
      return json(result);
    };
    if (meta.status !== body.expected) return fail("cas-mismatch");
    if (!isLegalContributionTransition(meta.status, next.status)) return fail("illegal-transition");
    const event: ContributionEvent = {
      status: next.status,
      at: nowIso(),
      ...(next.note !== undefined ? { note: next.note } : {}),
      ...(next.status === "published" ? { worldState: next.worldState } : {}),
    };
    const updated: ContributionMeta = { ...meta, status: next.status, events: [...meta.events, event] };
    const moved = await repo.meta.compareAndSwap(key, raw, JSON.stringify(updated));
    if (!moved.ok) return fail("cas-mismatch");
    return json({ id, ok: true, status: next.status });
  }

  async function handleSearch(name: string, req: Request): Promise<Response> {
    const repo = await openRepo(name);
    const body = await readJsonBody(req);
    const query = requireString(body, "query");
    const kind = body.kind;
    if (kind !== "code" && kind !== "history" && kind !== "provenance") throw badRequest(`invalid kind: ${String(kind)}`);
    if (body.cursor !== undefined && typeof body.cursor !== "string") throw badRequest("cursor must be a string");
    const limit = pageLimit(body.limit);
    const options = { cursor: body.cursor as string | undefined, limit };
    const page =
      kind === "code"
        ? await searchCode(repo, query, options)
        : kind === "history"
          ? await searchHistory(repo, query, options)
          : await searchProvenance(repo, query, options);
    const res: RepoSearchResponse = {
      hits: page.hits,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor as Cursor } : {}),
    };
    return json(res);
  }

  async function handleReady(): Promise<Response> {
    const checks = { objects: true, meta: true };
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !REPO_NAME.test(entry.name)) continue;
        if (checks.objects && !(await fileExists(join(root, entry.name, ".javelin", "objects")))) checks.objects = false;
        if (checks.meta && !(await fileExists(join(root, entry.name, ".javelin", "meta")))) checks.meta = false;
      }
    } catch {
      checks.objects = false;
      checks.meta = false;
    }
    const res: ReadyzResponse = { ok: checks.objects && checks.meta, checks };
    return json(res);
  }

  function requireAuth(req: Request, health: boolean): void {
    if (!opts.token || health) return;
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${opts.token}`) {
      throw new HttpError(STATUS_HTTP.unauthorized, "unauthorized", "missing or invalid bearer token");
    }
  }

  function checkVersion(req: Request, health: boolean): void {
    const version = req.headers.get(JRP_VERSION_HEADER);
    if (version === String(JRP_VERSION)) return;
    if (version === null && health) return;
    throw new HttpError(
      STATUS_HTTP.version_not_supported,
      "version_not_supported",
      "unsupported JRP version",
      [JRP_VERSION],
    );
  }

  async function route(req: Request, url: URL): Promise<Response> {
    const seg = url.pathname.split("/").filter(Boolean);
    const health = seg.length === 3 && seg[0] === "jrp" && seg[1] === "v2" && (seg[2] === "healthz" || seg[2] === "readyz");
    checkVersion(req, health);
    requireAuth(req, health);

    if (health) {
      if (req.method !== "GET") throw badRequest(`unsupported method ${req.method}`);
      return seg[2] === "healthz" ? json({ ok: true } satisfies HealthzResponse) : handleReady();
    }

    if (seg[0] !== "jrp" || seg[1] !== "v2") throw notFound(`no route: ${req.method} ${url.pathname}`);

    if (seg.length === 3 && seg[2] === "repos") {
      if (req.method === "POST") return handleReposCreate(req);
      if (req.method === "GET") return handleReposList(url);
      throw badRequest(`unsupported method ${req.method} for ${url.pathname}`);
    }

    if (seg.length >= 4 && seg[2] === "repos") {
      const name = seg[3]!;
      const tail = seg.slice(4);
      const method = req.method;

      if (tail.length === 1 && tail[0] === "heads") {
        if (method !== "GET") throw badRequest(`unsupported method ${method}`);
        return handleHeadsGet(name);
      }
      if (tail.length === 2 && tail[0] === "heads" && tail[1] === "update") {
        if (method !== "POST") throw badRequest(`unsupported method ${method}`);
        return handleHeadsUpdate(name, req);
      }
      if (tail.length === 2 && tail[0] === "objects" && tail[1] === "batch-fetch") {
        if (method !== "POST") throw badRequest(`unsupported method ${method}`);
        return handleBatchFetch(name, req);
      }
      if (tail.length === 2 && tail[0] === "objects" && tail[1] === "batch-upload") {
        if (method !== "POST") throw badRequest(`unsupported method ${method}`);
        return handleBatchUpload(name, req);
      }
      if (tail.length === 2 && tail[0] === "raw") {
        const idRaw = tail[1]!;
        if (!isObjectId(idRaw)) throw badRequest("invalid object id");
        const repo = await openRepo(name);
        if (method === "PUT") return handleRawPut(repo, objectId(idRaw), req);
        if (method === "GET") return handleRawGet(repo, objectId(idRaw));
        throw badRequest(`unsupported method ${method}`);
      }
      if (tail.length === 2 && tail[0] === "states" && tail[1] === "log") {
        if (method !== "POST") throw badRequest(`unsupported method ${method}`);
        return handleStatesLog(name, req);
      }
      if (tail.length === 1 && tail[0] === "provenance" && method === "POST") return handleProvenancePut(name, req);
      if (tail.length === 2 && tail[0] === "provenance" && tail[1] === "query" && method === "POST") {
        return handleProvenanceQuery(name, req);
      }
      if (tail.length === 1 && tail[0] === "evidence" && method === "POST") return handleEvidencePut(name, req);
      if (tail.length === 2 && tail[0] === "evidence" && tail[1] === "query" && method === "POST") {
        return handleEvidenceQuery(name, req);
      }
      if (tail.length === 1 && tail[0] === "contributions") {
        if (method === "POST") return handleContributionCreate(name, req);
        if (method === "GET") return handleContributionList(name, url);
        throw badRequest(`unsupported method ${method}`);
      }
      if (tail.length === 3 && tail[0] === "contributions" && tail[2] === "status" && method === "POST") {
        return handleContributionStatus(name, tail[1]!, req);
      }
      if (tail.length === 1 && tail[0] === "search") {
        if (method !== "POST") throw badRequest(`unsupported method ${method}`);
        return handleSearch(name, req);
      }
    }

    throw notFound(`no route: ${req.method} ${url.pathname}`);
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch: async (req) => {
      const start = performance.now();
      const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
      const url = new URL(req.url);
      let response: Response;
      try {
        response = await route(req, url);
      } catch (e) {
        response = errorResponse(e);
      }
      logRequest({
        requestId,
        method: req.method,
        path: url.pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - start),
      });
      return response;
    },
  });

  return {
    port: server.port ?? 0,
    hostname: server.hostname ?? "localhost",
    stop: () => server.stop(true),
  };
}
