import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Commit, ObjectId, RefName, RefUpdateResult, Tree } from "@javelin/protocol";
import { isObjectId } from "@javelin/protocol";
import { makeTree, sortTreeEntries, encodeObject, hashEncoding, type BlobObject, type StoredObject } from "./objects";
import { ObjectStore } from "./store";

const NULL_ID = "0".repeat(64);

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${crypto.randomUUID()}`);
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

export class Refs {
  constructor(readonly dir: string) {}

  private path(ref: RefName): string {
    if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
      throw new Error(`invalid ref name: ${ref}`);
    }
    return join(this.dir, ...ref.split("/"));
  }

  async get(ref: RefName): Promise<ObjectId | null> {
    try {
      const raw = (await readFile(this.path(ref), "utf8")).trim();
      if (!isObjectId(raw)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  async set(ref: RefName, id: ObjectId | null, expectedOld: ObjectId | null = null): Promise<RefUpdateResult> {
    const current = await this.get(ref);
    const effectiveOld = current ?? null;
    if (expectedOld !== effectiveOld) {
      return { ref, ok: false, reason: "cas-mismatch", detail: `expected ${expectedOld ?? NULL_ID}, found ${effectiveOld ?? NULL_ID}` };
    }
    if (id === null) {
      try {
        await rm(this.path(ref));
      } catch {}
    } else {
      await atomicWrite(this.path(ref), id + "\n");
    }
    return { ref, ok: true };
  }

  async list(): Promise<Record<RefName, ObjectId>> {
    const refs: Record<RefName, ObjectId> = {};
    const walk = async (rel: string[]): Promise<void> => {
      const dir = join(this.dir, ...rel);
      let entries: string[];
      try {
        entries = await readdir(dir, { withFileTypes: true }).then((d) => d.map((e) => e.name));
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        if (name.startsWith(".tmp-")) continue;
        const parts = [...rel, name];
        const id = await this.get(parts.join("/") as RefName);
        if (id) refs[parts.join("/") as RefName] = id;
        else await walk(parts);
      }
    };
    await walk([]);
    return refs;
  }
}

export interface Author {
  name: string;
  email: string;
}

export interface CommitOptions {
  message: string;
  author?: Author;
  committer?: Author;
  parents?: ObjectId[];
  time?: string;
}

export interface LogEntry {
  id: ObjectId;
  commit: Commit;
}

export interface DiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  oldId: ObjectId | null;
  newId: ObjectId | null;
}

export interface MergeConflict {
  path: string;
  baseId: ObjectId | null;
  oursId: ObjectId | null;
  theirsId: ObjectId | null;
}

export interface MergeResult {
  ok: boolean;
  commitId: ObjectId | null;
  conflicts: MergeConflict[];
}

export interface FsckIssue {
  id: ObjectId;
  problem: string;
}

export interface FsckResult {
  ok: boolean;
  objects: number;
  issues: FsckIssue[];
}

export class Repository {
  readonly objects: ObjectStore;
  readonly refs: Refs;

  private constructor(
    readonly root: string,
    private readonly javelinDir: string,
  ) {
    this.objects = new ObjectStore(join(javelinDir, "objects"));
    this.refs = new Refs(join(javelinDir, "refs"));
  }

  static async open(root: string): Promise<Repository> {
    const javelinDir = join(root, ".javelin");
    await mkdir(join(javelinDir, "objects"), { recursive: true });
    await mkdir(join(javelinDir, "refs"), { recursive: true });
    return new Repository(root, javelinDir);
  }
  private indexPath(): string {
    return join(this.javelinDir, "index.json");
  }

  async readIndex(): Promise<Record<string, ObjectId>> {
    try {
      const raw = JSON.parse(await readFile(this.indexPath(), "utf8")) as Record<string, string>;
      const out: Record<string, ObjectId> = {};
      for (const [path, id] of Object.entries(raw)) if (isObjectId(id)) out[path] = id;
      return out;
    } catch {
      return {};
    }
  }

  async writeIndex(index: Record<string, ObjectId>): Promise<void> {
    await atomicWrite(this.indexPath(), JSON.stringify(index, null, 2) + "\n");
  }

  async stage(path: string, data: Uint8Array): Promise<ObjectId> {
    const blob: BlobObject = { kind: "blob", data };
    const { id } = await this.objects.write(blob);
    const index = await this.readIndex();
    index[normalizePath(path)] = id;
    await this.writeIndex(index);
    return id;
  }

  async unstage(path: string): Promise<void> {
    const index = await this.readIndex();
    delete index[normalizePath(path)];
    await this.writeIndex(index);
  }

  async buildTreeFromIndex(): Promise<ObjectId> {
    const index = await this.readIndex();
    return this.writeFlatTree(index);
  }

  private async writeFlatTree(files: Record<string, ObjectId>): Promise<ObjectId> {
    type Dir = Map<string, Dir | ObjectId>;
    const rootDir: Dir = new Map();
    for (const [path, id] of Object.entries(files)) {
      const parts = normalizePath(path).split("/");
      let dir = rootDir;
      for (const part of parts.slice(0, -1)) {
      let next = dir.get(part);
      if (!(next instanceof Map)) {
        next = new Map();
        dir.set(part, next);
      }
        dir = next;
      }
      dir.set(parts[parts.length - 1]!, id);
    }
    const writeDir = async (dir: Dir): Promise<ObjectId> => {
      const entries = [];
      for (const [name, value] of [...dir.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (value instanceof Map) {
          entries.push({ name, kind: "tree" as const, id: await writeDir(value) });
        } else {
          entries.push({ name, kind: "blob" as const, id: value });
        }
      }
      const tree = makeTree(entries);
      const { id } = await this.objects.write(tree);
      return id;
    };
    return writeDir(rootDir);
  }

  async commit(opts: CommitOptions): Promise<ObjectId> {
    const head = await this.refs.get(`refs/heads/${await this.currentBranch()}`);
    const headFiles = head ? await this.readCommitTree(head) : {};
    const index = await this.readIndex();
    const files = { ...headFiles, ...index };
    const tree = await this.writeFlatTree(files);
    const time = opts.time ?? new Date().toISOString();
    const author = opts.author ?? { name: "javelin", email: "javelin@local" };
    const committer = opts.committer ?? author;
    const parents = opts.parents ?? (head ? [head] : []);
    const commit = {
      kind: "commit" as const,
      tree,
      parents,
      author: { ...author, time },
      committer: { ...committer, time },
      message: opts.message,
    };
    const { id } = await this.objects.write(commit);
    const branch = `refs/heads/${await this.currentBranch()}`;
    const result = await this.refs.set(branch, id, head);
    if (!result.ok) throw new Error(`commit failed to move ${branch}: ${result.detail}`);
    await this.writeIndex(files);
    return id;
  }

  async currentBranch(): Promise<string> {
    const head = await this.headBranch();
    if (head) return head;
    return "main";
  }

  private async headBranch(): Promise<string | null> {
    try {
      const raw = (await readFile(join(this.javelinDir, "HEAD"), "utf8")).trim();
      const m = /^ref: (refs\/heads\/.+)$/.exec(raw);
      return m ? m[1]!.slice("refs/heads/".length) : null;
    } catch {
      return null;
    }
  }

  async setHeadBranch(branch: string): Promise<void> {
    await atomicWrite(join(this.javelinDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  }

  async loadCommit(id: ObjectId): Promise<Commit> {
    const obj = await this.objects.read(id);
    if (!obj || obj.kind !== "commit") throw new Error(`not a commit: ${id}`);
    return obj;
  }

  async loadTree(id: ObjectId): Promise<Tree> {
    const obj = await this.objects.read(id);
    if (!obj || obj.kind !== "tree") throw new Error(`not a tree: ${id}`);
    return obj;
  }

  async readTree(path: string, treeId: ObjectId): Promise<Record<string, ObjectId>> {
    const flat: Record<string, ObjectId> = {};
    const prefix = normalizePath(path);
    const walk = async (id: ObjectId, dir: string): Promise<void> => {
      const tree = await this.loadTree(id);
      for (const entry of tree.entries) {
        const full = dir ? `${dir}/${entry.name}` : entry.name;
        if (prefix && !full.startsWith(prefix + "/") && full !== prefix) continue;
        if (entry.kind === "blob") flat[full] = entry.id;
        else await walk(entry.id, full);
      }
    };
    await walk(treeId, "");
    return flat;
  }

  async readCommitTree(commitId: ObjectId): Promise<Record<string, ObjectId>> {
    const commit = await this.loadCommit(commitId);
    return this.readTree("", commit.tree);
  }

  async resolveToCommit(refOrId: string): Promise<ObjectId> {
    if (isObjectId(refOrId)) return refOrId;
    for (const candidate of [`refs/heads/${refOrId}`, `refs/tags/${refOrId}`, refOrId]) {
      const id = await this.refs.get(candidate);
      if (id) return id;
    }
    throw new Error(`cannot resolve ${refOrId} to a commit`);
  }

  async log(start: string, limit = 100): Promise<LogEntry[]> {
    const startId = await this.resolveToCommit(start);
    const seen = new Set<string>();
    const queue = [startId];
    const entries: LogEntry[] = [];
    while (queue.length > 0 && entries.length < limit) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const commit = await this.loadCommit(id);
      entries.push({ id, commit });
      for (const parent of [...commit.parents].reverse()) queue.unshift(parent);
    }
    return entries;
  }

  async checkout(target: string): Promise<void> {
    const commitId = await this.resolveToCommit(target);
    const files = await this.readCommitTree(commitId);
    await this.applyToWorkingTree(files);
    await this.writeIndex(files);
    for (const ref of [`refs/heads/${target}`, `refs/tags/${target}`]) {
      if (await this.refs.get(ref)) {
        if (ref.startsWith("refs/heads/")) {
          await this.setHeadBranch(target);
        }
        break;
      }
    }
  }

  private async applyToWorkingTree(files: Record<string, ObjectId>): Promise<void> {
    for (const [path, id] of Object.entries(files)) {
      const obj = await this.objects.read(id);
      if (!obj || obj.kind !== "blob") throw new Error(`missing blob ${id} for ${path}`);
      await atomicWriteBytes(join(this.root, path), obj.data);
    }
  }

  async readBlob(id: ObjectId): Promise<Uint8Array> {
    const obj = await this.objects.read(id);
    if (!obj || obj.kind !== "blob") throw new Error(`not a blob: ${id}`);
    return obj.data;
  }

  async diff(a: string, b: string): Promise<DiffEntry[]> {
    const [filesA, filesB] = await Promise.all([
      this.commitFlat(a),
      this.commitFlat(b),
    ]);
    const entries: DiffEntry[] = [];
    for (const path of [...new Set([...Object.keys(filesA), ...Object.keys(filesB)])].sort()) {
      const oldId = filesA[path] ?? null;
      const newId = filesB[path] ?? null;
      if (oldId === newId) continue;
      if (!oldId) entries.push({ path, status: "added", oldId, newId });
      else if (!newId) entries.push({ path, status: "deleted", oldId, newId });
      else entries.push({ path, status: "modified", oldId, newId });
    }
    return entries;
  }

  private async commitFlat(ref: string): Promise<Record<string, ObjectId>> {
    const commitId = await this.resolveToCommit(ref);
    return this.readCommitTree(commitId);
  }

  async createBranch(name: string, from?: string): Promise<RefUpdateResult> {
    const start = from ?? (await this.currentBranch());
    const commitId = await this.resolveToCommit(start);
    return this.refs.set(`refs/heads/${name}`, commitId);
  }

  async deleteBranch(name: string): Promise<RefUpdateResult> {
    const ref = `refs/heads/${name}`;
    if ((await this.currentBranch()) === name) {
      return { ref, ok: false, reason: "policy-rejected", detail: "cannot delete the checked-out branch" };
    }
    const id = await this.refs.get(ref);
    return this.refs.set(ref, null, id);
  }

  async listBranches(): Promise<{ name: string; id: ObjectId }[]> {
    const refs = await this.refs.list();
    return Object.entries(refs)
      .filter(([ref]) => ref.startsWith("refs/heads/"))
      .map(([ref, id]) => ({ name: ref.slice("refs/heads/".length), id }));
  }

  private async ancestors(id: ObjectId): Promise<Set<string>> {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = await this.loadCommit(current);
      queue.push(...commit.parents);
    }
    return seen;
  }

  private async mergeBase(ours: ObjectId, theirs: ObjectId): Promise<ObjectId | null> {
    const oursAncestors = await this.ancestors(ours);
    const seen = new Set<string>();
    const queue = [theirs];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (oursAncestors.has(current)) return current;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = await this.loadCommit(current);
      queue.push(...commit.parents);
    }
    return null;
  }

  async mergeBranch(other: string, opts?: { author?: Author; message?: string }): Promise<MergeResult> {
    const oursId = await this.resolveToCommit(await this.currentBranch());
    const theirsId = await this.resolveToCommit(other);
    if (oursId === theirsId) return { ok: true, commitId: oursId, conflicts: [] };
    const baseId = await this.mergeBase(oursId, theirsId);
    if (baseId === theirsId) return { ok: true, commitId: oursId, conflicts: [] };
    const baseFiles = baseId ? await this.readCommitTree(baseId) : {};
    const oursFiles = await this.readCommitTree(oursId);
    const theirsFiles = await this.readCommitTree(theirsId);

    const merged: Record<string, ObjectId> = { ...oursFiles };
    const conflicts: MergeConflict[] = [];
    for (const path of new Set([...Object.keys(baseFiles), ...Object.keys(theirsFiles)])) {
      const b = baseFiles[path] ?? null;
      const o = oursFiles[path] ?? null;
      const t = theirsFiles[path] ?? null;
      if (t === b || t === o) continue;
      if (o === b) {
        if (t === null) delete merged[path];
        else merged[path] = t;
        continue;
      }
      conflicts.push({ path, baseId: b, oursId: o, theirsId: t });
    }
    if (conflicts.length > 0) {
      conflicts.sort((a, b) => (a.path < b.path ? -1 : 1));
      return { ok: false, commitId: null, conflicts };
    }
    await this.applyToWorkingTree(merged);
    await this.writeIndex(merged);
    const message = opts?.message ?? `merge branch '${other}'`;
    const time = new Date().toISOString();
    const author = opts?.author ?? { name: "javelin", email: "javelin@local" };
    const mergeCommit = {
      kind: "commit" as const,
      tree: await this.writeFlatTree(merged),
      parents: [oursId, theirsId],
      author: { ...author, time },
      committer: { ...author, time },
      message,
    };
    const { id } = await this.objects.write(mergeCommit);
    const head = await this.refs.get(`refs/heads/${await this.currentBranch()}`);
    await this.refs.set(`refs/heads/${await this.currentBranch()}`, id, head);
    return { ok: true, commitId: id, conflicts: [] };
  }

  async fsck(): Promise<FsckResult> {
    const issues: FsckIssue[] = [];
    const reachable = new Set<string>();
    const verify = async (id: ObjectId): Promise<StoredObject | null> => {
      const obj = await this.objects.read(id);
      if (!obj) {
        const raw = await this.objects.readRaw(id);
        issues.push({ id, problem: raw ? "corrupt object" : "missing object" });
        return null;
      }
      const expected = await hashEncoding(encodeObject(obj));
      if (expected !== id) issues.push({ id, problem: `hash mismatch: content hashes to ${expected}` });
      reachable.add(id);
      return obj;
    };
    const walkTree = async (id: ObjectId): Promise<void> => {
      const tree = await verify(id);
      if (!tree || tree.kind !== "tree") return;
      for (const entry of sortTreeEntries(tree.entries)) {
        if (reachable.has(entry.id)) continue;
        if (entry.kind === "tree") await walkTree(entry.id);
        else await verify(entry.id);
      }
    };
    const walkCommit = async (id: ObjectId): Promise<void> => {
      const commit = await verify(id);
      if (!commit || commit.kind !== "commit") return;
      await walkTree(commit.tree);
      for (const parent of commit.parents) {
        if (!reachable.has(parent)) await walkCommit(parent);
      }
      for (const prov of commit.provenance ?? []) {
        if (!reachable.has(prov)) await verify(prov);
      }
    };
    for (const id of Object.values(await this.refs.list())) {
      const obj = await this.objects.read(id);
      if (!obj) {
        issues.push({ id, problem: "missing object referenced by ref" });
        continue;
      }
      if (obj.kind === "commit") await walkCommit(id);
      else if (obj.kind === "tag") await verify(obj.target);
      else await verify(id);
    }
    return { ok: issues.length === 0, objects: reachable.size, issues };
  }
}

export function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

export async function openRepository(rootPath: string): Promise<Repository> {
  return Repository.open(rootPath);
}

async function atomicWriteBytes(path: string, data: Uint8Array): Promise<void> {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.javelin-tmp-${crypto.randomUUID()}`);
  await writeFile(tmp, data);
  await rename(tmp, path);
}
