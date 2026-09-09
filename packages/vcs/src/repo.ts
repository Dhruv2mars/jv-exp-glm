import { chmod, lstat, mkdir, readlink, readdir, readFile, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Contribution,
  ContributionEvent,
  ContributionStatus,
  EvidenceRecord,
  FileMode,
  LayerRef,
  ObjectId,
  Person,
  ProvenanceRecord,
  State,
  Tree,
} from "../../protocol/src/model";
import { isObjectId, objectId } from "@javelin/protocol";
import {
  decodeObject,
  encodeObject,
  hashEncoding,
  makeTree,
  type BlobObject,
  type StoredObject,
} from "./objects";
import { diff3, joinLines, splitLines } from "./merge";
import { MetaStore } from "./meta";
import { ObjectStore } from "./store";

export interface Author {
  name: string;
  email: string;
}

export interface FileEntry {
  id: ObjectId;
  mode: FileMode;
}

export type FileMap = Record<string, FileEntry>;

export interface LogEntry {
  id: ObjectId;
  state: State;
}

export interface MergeConflict {
  path: string;
  kind: "content" | "add-add" | "delete-modify" | "binary";
  baseId: ObjectId | null;
  oursId: ObjectId | null;
  theirsId: ObjectId | null;
}

export interface RefreshResult {
  ok: boolean;
  stateId: ObjectId | null;
  conflicts: MergeConflict[];
  reason: "layer-moved" | null;
}

export type PublishFailure = "not-found" | "not-open" | "conflict" | "world-moved" | "status-moved";

export interface PublishResult {
  ok: boolean;
  idempotent: boolean;
  worldState: ObjectId | null;
  reason: PublishFailure | null;
  conflicts: MergeConflict[];
}

export interface ContributionMeta {
  contributionId: ObjectId;
  status: ContributionStatus;
  events: ContributionEvent[];
}

export interface GcResult {
  removed: number;
}

export interface FsckIssue {
  id: ObjectId;
  problem: string;
}

export interface FsckResult {
  ok: boolean;
  objects: number;
  unreachable: ObjectId[];
  issues: FsckIssue[];
}

const LAYER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GC_GRACE_MS = 3_600_000;

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function now(): string {
  return new Date().toISOString();
}

function person(author?: Author): Person {
  return {
    name: author?.name ?? "javelin",
    email: author?.email ?? "javelin@local",
    time: now(),
  };
}

function worldValue(id: ObjectId | null): string {
  return JSON.stringify({ value: id });
}

/** Git's heuristic: content with a NUL byte in the first 8k is binary, not text. */
function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export class Repository {
  readonly objects: ObjectStore;
  readonly meta: MetaStore;

  protected constructor(
    readonly root: string,
    private readonly javelinDir: string,
  ) {    this.objects = new ObjectStore(join(javelinDir, "objects"));
    this.meta = new MetaStore(join(javelinDir, "meta"));
  }

  static async open(root: string): Promise<Repository> {
    const javelinDir = join(root, ".javelin");
    await mkdir(join(javelinDir, "objects"), { recursive: true });
    await mkdir(join(javelinDir, "meta"), { recursive: true });
    return new Repository(root, javelinDir);
  }

  /**
   * Bootstrap an empty repository: an initial empty world state so every layer has a
   * valid base, plus the current-layer pointer. Safe to call on an already-initialized
   * repository; concurrent inits converge through CAS on meta/world.
   */
  static async init(root: string): Promise<Repository> {
    const repo = await Repository.open(root);
    if ((await repo.meta.get("world")) === null) await repo.meta.create("world", worldValue(null));
    if ((await repo.worldHead()) === null) {
      const treeId = (await repo.objects.write(makeTree([]))).id;
      const state: State = { kind: "state", tree: treeId, parents: [], author: person(), message: "init" };
      const { id } = await repo.objects.write(state);
      const raw = await repo.meta.get("world");
      await repo.meta.compareAndSwap("world", raw!, worldValue(id));
    }
    await repo.meta.create("current", "world");
    return repo;
  }

  // ---- world ----

  async worldHead(): Promise<ObjectId | null> {
    const raw = await this.meta.get("world");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value: ObjectId | null };
    return parsed.value !== null && isObjectId(parsed.value) ? parsed.value : null;
  }

  async worldLog(limit = 100): Promise<LogEntry[]> {
    const head = await this.worldHead();
    if (!head) return [];
    return this.logFrom(head, limit);
  }

  // ---- layers ----

  async layerNew(name: string): Promise<LayerRef> {
    if (!LAYER_NAME_RE.test(name)) throw new Error(`invalid layer name: ${name}`);
    const world = await this.worldHead();
    if (!world) throw new Error("world head missing; run init first");
    const ref: LayerRef = { name, base: world, head: null, updatedAt: now() };
    const created = await this.meta.create(`layer/${name}`, JSON.stringify(ref));
    if (!created) throw new Error(`layer already exists: ${name}`);
    return ref;
  }

  async layerList(): Promise<LayerRef[]> {
    const refs: LayerRef[] = [];
    for (const key of await this.meta.list("layer/")) {
      const raw = await this.meta.get(key);
      if (raw) refs.push(JSON.parse(raw) as LayerRef);
    }
    return refs.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async layerGet(name: string): Promise<LayerRef | null> {
    const raw = await this.meta.get(`layer/${name}`);
    return raw ? (JSON.parse(raw) as LayerRef) : null;
  }

  /** Checkout a layer (or "world") into the working directory, including deletions. */
  async layerSwitch(name: string): Promise<LayerRef | "world"> {
    if (name === "world") {
      const head = await this.worldHead();
      if (head) await this.materialize(head);
      await this.meta.compareAndSwap("current", await this.meta.get("current"), "world");
      return "world";
    }
    const ref = await this.layerGet(name);
    if (!ref) throw new Error(`no such layer: ${name}`);
    await this.materialize(ref.head ?? ref.base);
    await this.meta.compareAndSwap("current", await this.meta.get("current"), name);
    return ref;
  }

  /** Delete a layer's metadata. Objects stay; they become unreachable (gc reclaims them). */
  async layerDiscard(name: string): Promise<void> {
    const deleted = await this.meta.delete(`layer/${name}`);
    if (!deleted) throw new Error(`no such layer: ${name}`);
    if ((await this.meta.get("current")) === name) {
      await this.meta.compareAndSwap("current", name, "world");
    }
  }

  async currentLayer(): Promise<string> {
    return (await this.meta.get("current")) ?? "world";
  }

  /**
   * Snapshot the working directory onto the checked-out layer. Parents are the layer's
   * previous head ([] for the first checkpoint). The layer head moves by CAS; a racing
   * writer makes the checkpoint fail loudly instead of losing work.
   */
  async checkpoint(opts: { message: string; author?: Author; layer?: string }): Promise<{ stateId: ObjectId; layer: string }> {
    const layer = opts.layer ?? (await this.currentLayer());
    if (layer === "world") throw new Error("checkpoint requires a checked-out layer");
    const raw = await this.meta.get(`layer/${layer}`);
    if (!raw) throw new Error(`no such layer: ${layer}`);
    const ref = JSON.parse(raw) as LayerRef;
    const treeId = await this.writeTreeFromFiles(await this.scanWorkingDir());
    const state: State = {
      kind: "state",
      tree: treeId,
      parents: ref.head ? [ref.head] : [],
      author: person(opts.author),
      message: opts.message,
    };
    const { id } = await this.objects.write(state);
    const next: LayerRef = { ...ref, head: id, updatedAt: now() };
    const moved = await this.meta.compareAndSwap(`layer/${layer}`, raw, JSON.stringify(next));
    if (!moved.ok) throw new Error(`layer ${layer} moved during checkpoint; retry`);
    return { stateId: id, layer };
  }

  async layerLog(layer: string, limit = 100): Promise<LogEntry[]> {
    const ref = await this.layerGet(layer);
    if (!ref) throw new Error(`no such layer: ${layer}`);
    if (!ref.head) return [];
    return this.logFrom(ref.head, limit);
  }

  // ---- refresh ----

  /**
   * Three-way line merge of World into a layer. Base is the common ancestor of the layer
   * chain and the world chain. On success the merged tree is materialized and the layer
   * head CAS-advances to a merge state with parents [layerHead, worldHead]. On conflict
   * nothing is written.
   */
  async refresh(layer: string): Promise<RefreshResult> {
    const raw = await this.meta.get(`layer/${layer}`);
    if (!raw) throw new Error(`no such layer: ${layer}`);
    const ref = JSON.parse(raw) as LayerRef;
    if (!ref.head) throw new Error(`layer has no checkpoints: ${layer}`);
    const world = await this.worldHead();
    if (!world) throw new Error("world head missing");
    let base = await this.mergeBase(ref.head, world);
    if (!base && (await this.isAncestorOrSelf(ref.base, world))) base = ref.base;
    if (!base || base === world) return { ok: true, stateId: null, conflicts: [], reason: null };
    const { files, conflicts } = await this.mergeTrees(base, ref.head, world);
    if (!files) return { ok: false, stateId: null, conflicts, reason: null };
    const treeId = await this.writeTreeFromFiles(files);
    const state: State = {
      kind: "state",
      tree: treeId,
      parents: [ref.head, world],
      author: person(),
      message: `refresh ${layer}`,
    };
    const { id } = await this.objects.write(state);
    const moved = await this.meta.compareAndSwap(
      `layer/${layer}`,
      raw,
      JSON.stringify({ ...ref, head: id, updatedAt: now() } satisfies LayerRef),
    );
    if (!moved.ok) return { ok: false, stateId: null, conflicts: [], reason: "layer-moved" };
    await this.materialize(id);
    return { ok: true, stateId: id, conflicts: [], reason: null };
  }

  // ---- contributions ----

  async contribute(layer: string, title: string, author: Author): Promise<ObjectId> {
    const ref = await this.layerGet(layer);
    if (!ref) throw new Error(`no such layer: ${layer}`);
    if (!ref.head) throw new Error(`layer has no checkpoints: ${layer}`);
    const contribution: Contribution = {
      kind: "contribution",
      layer,
      state: ref.head,
      base: ref.base,
      title,
      author: person(author),
      createdAt: now(),
    };
    const { id } = await this.objects.write(contribution);
    const meta: ContributionMeta = {
      contributionId: id,
      status: "open",
      events: [{ status: "open", at: now(), by: author.name }],
    };
    const created = await this.meta.create(`contrib/${id}`, JSON.stringify(meta));
    if (!created) throw new Error(`contribution already exists: ${id}`);
    return id;
  }

  async contribution(id: ObjectId): Promise<{ contribution: Contribution; meta: ContributionMeta } | null> {
    const raw = await this.meta.get(`contrib/${id}`);
    if (!raw) return null;
    const obj = await this.objects.read(id);
    if (!obj || obj.kind !== "contribution") throw new Error(`missing contribution object: ${id}`);
    return { contribution: obj, meta: JSON.parse(raw) as ContributionMeta };
  }

  /**
   * Integrate a contribution into World. The world head moves by CAS from the value the
   * merge was computed against; if it moved mid-publish nothing changes and the caller
   * refreshes. Re-publishing a published contribution is a no-op success.
   */
  async publish(contributionId: ObjectId, author: Author): Promise<PublishResult> {
    const key = `contrib/${contributionId}`;
    const raw = await this.meta.get(key);
    if (!raw) return this.publishFailure("not-found");
    const cmeta = JSON.parse(raw) as ContributionMeta;
    if (cmeta.status === "published") {
      const worldState = [...cmeta.events].reverse().find((e) => e.status === "published")?.worldState ?? null;
      return { ok: true, idempotent: true, worldState, reason: null, conflicts: [] };
    }
    if (cmeta.status !== "open") return this.publishFailure("not-open");
    const obj = await this.objects.read(contributionId);
    if (!obj || obj.kind !== "contribution") throw new Error(`missing contribution object: ${contributionId}`);
    const contribution = obj;
    const worldRaw = await this.meta.get("world");
    const world = worldRaw === null ? null : (JSON.parse(worldRaw) as { value: ObjectId | null }).value;
    if (!world) throw new Error("world head missing");
    if (contribution.state === world) {
      const event: ContributionEvent = { status: "published", at: now(), by: author.name, worldState: world };
      const moved = await this.meta.compareAndSwap(
        key,
        raw,
        JSON.stringify({ ...cmeta, status: "published", events: [...cmeta.events, event] } satisfies ContributionMeta),
      );
      if (!moved.ok) return this.publishFailure("status-moved");
      return { ok: true, idempotent: false, worldState: world, reason: null, conflicts: [] };
    }
    if (await this.isAncestorOrSelf(contribution.state, world)) {
      const event: ContributionEvent = { status: "published", at: now(), by: author.name, worldState: world };
      await this.meta.compareAndSwap(
        key,
        raw,
        JSON.stringify({ ...cmeta, status: "published", events: [...cmeta.events, event] } satisfies ContributionMeta),
      );
      return { ok: true, idempotent: true, worldState: world, reason: null, conflicts: [] };
    }
    const base =
      (await this.isAncestorOrSelf(contribution.base, world))
        ? contribution.base
        : await this.mergeBase(contribution.state, world);
    if (!base) throw new Error("no merge base between contribution and world");
    const { files, conflicts } = await this.mergeTrees(base, contribution.state, world);
    if (!files) return { ok: false, idempotent: false, worldState: null, reason: "conflict", conflicts };
    const treeId = await this.writeTreeFromFiles(files);
    const state: State = {
      kind: "state",
      tree: treeId,
      parents: [world, contribution.state],
      author: person(author),
      message: `publish ${contribution.layer}: ${contribution.title}`,
    };
    const { id } = await this.objects.write(state);
    if (!(await this.casWorld(worldRaw!, id))) return this.publishFailure("world-moved");
    const event: ContributionEvent = { status: "published", at: now(), by: author.name, worldState: id };
    const statusMoved = await this.meta.compareAndSwap(
      key,
      raw,
      JSON.stringify({ ...cmeta, status: "published", events: [...cmeta.events, event] } satisfies ContributionMeta),
    );
    if (!statusMoved.ok) {
      const current = await this.meta.get(key);
      const latest = current ? (JSON.parse(current) as ContributionMeta) : null;
      const published = latest ? [...latest.events].reverse().find((e) => e.status === "published") : null;
      if (latest?.status === "published" && published?.worldState === id) {
        return { ok: true, idempotent: true, worldState: id, reason: null, conflicts: [] };
      }
      return this.publishFailure("status-moved");
    }
    return { ok: true, idempotent: false, worldState: id, reason: null, conflicts: [] };
  }

  /** CAS the world head from the exact value this publish merged against. */
  protected async casWorld(expectedRaw: string, next: ObjectId): Promise<boolean> {
    return (await this.meta.compareAndSwap("world", expectedRaw, worldValue(next))).ok;
  }

  private publishFailure(reason: PublishFailure): PublishResult {
    return { ok: false, idempotent: false, worldState: null, reason, conflicts: [] };
  }

  // ---- provenance and evidence (append-only, docs/adr/0005) ----

  async recordProvenance(record: Omit<ProvenanceRecord, "kind">): Promise<ObjectId> {
    const { id } = await this.objects.write({ kind: "provenance", ...record });
    return id;
  }

  async recordEvidence(record: Omit<EvidenceRecord, "kind">): Promise<ObjectId> {
    const { id } = await this.objects.write({ kind: "evidence", ...record });
    return id;
  }

  /**
   * Lookup scans the object store for records referencing the state. A derived index
   * was deliberately not added (docs/adr/0005); if benchmarks demand one it must stay a
   * rebuildable view, never the source of truth.
   */
  async provenanceFor(stateId: ObjectId): Promise<{ id: ObjectId; record: ProvenanceRecord }[]> {
    return this.scanRefs("provenance", stateId) as Promise<{ id: ObjectId; record: ProvenanceRecord }[]>;
  }

  async evidenceFor(stateId: ObjectId): Promise<{ id: ObjectId; record: EvidenceRecord }[]> {
    return this.scanRefs("evidence", stateId) as Promise<{ id: ObjectId; record: EvidenceRecord }[]>;
  }

  private async scanRefs(
    kind: "provenance" | "evidence",
    stateId: ObjectId,
  ): Promise<{ id: ObjectId; record: ProvenanceRecord | EvidenceRecord }[]> {
    const hits: { id: ObjectId; record: ProvenanceRecord | EvidenceRecord }[] = [];
    for (const id of await this.objects.list()) {
      const obj = await this.objects.read(id);
      if (!obj || obj.kind !== kind) continue;
      const references =
        obj.kind === "provenance" ? obj.states.includes(stateId) : obj.kind === "evidence" ? obj.state === stateId : false;
      if (references) hits.push({ id, record: obj });
    }
    return hits;
  }

  // ---- materialize and scan ----

  /** Write a state's tree to a directory, removing files the state does not contain. */
  async materialize(stateId: ObjectId, targetDir: string = this.root): Promise<void> {
    const state = await this.loadState(stateId);
    await this.writeWorkingTree(await this.flattenTree(state.tree), targetDir);
  }

  async scanWorkingDir(dir: string = this.root): Promise<FileMap> {
    const files: FileMap = {};
    const walk = async (d: string, prefix: string, depth: number): Promise<void> => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        if (depth === 0 && entry.name === ".javelin") continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = join(d, entry.name);
        if (entry.isDirectory()) {
          await walk(path, rel, depth + 1);
        } else if (entry.isFile()) {
          const blob: BlobObject = { kind: "blob", data: new Uint8Array(await readFile(path)) };
          const mode = (await stat(path)).mode & 0o111 ? "exec" : "file";
          files[rel] = { id: (await this.objects.write(blob)).id, mode };
        } else if (entry.isSymbolicLink()) {
          const blob: BlobObject = { kind: "blob", data: new TextEncoder().encode(await readlink(path)) };
          files[rel] = { id: (await this.objects.write(blob)).id, mode: "symlink" };
        }
      }
    };
    await walk(dir, "", 0);
    return files;
  }

  private async writeWorkingTree(files: FileMap, targetDir: string): Promise<void> {
    await this.pruneAbsent(files, targetDir, "", 0);
    for (const rel of Object.keys(files).sort()) {
      const entry = files[rel]!;
      const dest = join(targetDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      const blob = await this.readBlob(entry.id);
      if (entry.mode === "symlink") {
        await rm(dest, { force: true, recursive: true });
        await symlink(new TextDecoder().decode(blob), dest);
        continue;
      }
      try {
        if ((await lstat(dest)).isSymbolicLink()) await rm(dest, { force: true });
      } catch {}
      const tmp = join(dirname(dest), `.javelin-tmp-${crypto.randomUUID()}`);
      await writeFile(tmp, blob);
      await rename(tmp, dest);
      await chmod(dest, entry.mode === "exec" ? 0o755 : 0o644);
    }
  }

  private async pruneAbsent(files: FileMap, dir: string, prefix: string, depth: number): Promise<void> {
    for (const entry of await listDir(dir)) {
      if (depth === 0 && entry.name === ".javelin") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.pruneAbsent(files, path, rel, depth + 1);
        await rmdir(path).catch(() => {});
      } else if (!files[rel]) {
        await rm(path, { force: true });
      }
    }
  }

  // ---- tree helpers ----

  private async flattenTree(treeId: ObjectId): Promise<FileMap> {
    const files: FileMap = {};
    const walk = async (id: ObjectId, dir: string): Promise<void> => {
      for (const entry of (await this.loadTree(id)).entries) {
        const full = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.kind === "tree") await walk(entry.id, full);
        else files[full] = { id: entry.id, mode: entry.mode };
      }
    };
    await walk(treeId, "");
    return files;
  }

  private async writeTreeFromFiles(files: FileMap): Promise<ObjectId> {
    type Dir = Map<string, Dir | FileEntry>;
    const root: Dir = new Map();
    for (const [path, entry] of Object.entries(files)) {
      const parts = path.split("/");
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let next = dir.get(part);
        if (!(next instanceof Map)) {
          next = new Map();
          dir.set(part, next);
        }
        dir = next;
      }
      dir.set(parts[parts.length - 1]!, entry);
    }
    const writeDir = async (dir: Dir): Promise<ObjectId> => {
      const entries = [];
      for (const [name, value] of [...dir.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (value instanceof Map) {
          entries.push({ name, mode: "file" as const, kind: "tree" as const, id: await writeDir(value) });
        } else {
          entries.push({ name, mode: value.mode, kind: "blob" as const, id: value.id });
        }
      }
      return (await this.objects.write(makeTree(entries))).id;
    };
    return writeDir(root);
  }

  // ---- merge ----

  protected async mergeTrees(
    baseState: ObjectId | null,
    oursState: ObjectId,
    theirsState: ObjectId,
  ): Promise<{ files: FileMap | null; conflicts: MergeConflict[] }> {
    const [baseFiles, oursFiles, theirsFiles] = await Promise.all([
      baseState ? this.flattenTree((await this.loadState(baseState)).tree) : Promise.resolve({} as FileMap),
      this.flattenTree((await this.loadState(oursState)).tree),
      this.flattenTree((await this.loadState(theirsState)).tree),
    ]);
    const stamp = (entry: FileEntry | undefined): string | null => (entry ? `${entry.mode}:${entry.id}` : null);
    const files: FileMap = {};
    const conflicts: MergeConflict[] = [];
    const paths = [...new Set([...Object.keys(baseFiles), ...Object.keys(oursFiles), ...Object.keys(theirsFiles)])].sort();
    for (const path of paths) {
      const b = baseFiles[path];
      const o = oursFiles[path];
      const t = theirsFiles[path];
      const bs = stamp(b);
      const os = stamp(o);
      const ts = stamp(t);
      if (os === ts) {
        if (o) files[path] = o;
        continue;
      }
      if (os === bs) {
        if (t) files[path] = t;
        continue;
      }
      if (ts === bs) {
        if (o) files[path] = o;
        continue;
      }
      if (!b || !o || !t) {
        conflicts.push({
          path,
          kind: !b ? "add-add" : "delete-modify",
          baseId: b?.id ?? null,
          oursId: o?.id ?? null,
          theirsId: t?.id ?? null,
        });
        continue;
      }
      if (o.mode !== t.mode && o.mode !== b.mode && t.mode !== b.mode) {
        conflicts.push({ path, kind: "content", baseId: b.id, oursId: o.id, theirsId: t.id });
        continue;
      }
      const mode: FileMode = o.mode !== b.mode ? o.mode : t.mode;
      const [baseBytes, ourBytes, theirBytes] = await Promise.all([
        this.readBlob(b.id),
        this.readBlob(o.id),
        this.readBlob(t.id),
      ]);
      if (isBinary(baseBytes) || isBinary(ourBytes) || isBinary(theirBytes)) {
        conflicts.push({ path, kind: "binary", baseId: b.id, oursId: o.id, theirsId: t.id });
        continue;
      }
      const decode = (bytes: Uint8Array): string[] => splitLines(new TextDecoder().decode(bytes));
      const [baseLines, ourLines, theirLines] = [decode(baseBytes), decode(ourBytes), decode(theirBytes)];
      const merged = diff3(baseLines, ourLines, theirLines);
      if (!merged.lines) {
        conflicts.push({ path, kind: "content", baseId: b.id, oursId: o.id, theirsId: t.id });
        continue;
      }
      const blob: BlobObject = { kind: "blob", data: joinLines(merged.lines) };
      files[path] = { id: (await this.objects.write(blob)).id, mode };
    }
    return conflicts.length > 0 ? { files: null, conflicts } : { files, conflicts: [] };
  }

  private async logFrom(start: ObjectId, limit: number): Promise<LogEntry[]> {
    const seen = new Set<string>();
    const queue = [start];
    const entries: LogEntry[] = [];
    while (queue.length > 0 && entries.length < limit) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const state = await this.loadState(id);
      entries.push({ id, state });
      queue.unshift(...[...state.parents].reverse());
    }
    return entries;
  }

  private async ancestorSet(id: ObjectId): Promise<Set<string>> {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const state = await this.loadState(current);
      queue.push(...state.parents);
    }
    return seen;
  }

  private async mergeBase(a: ObjectId, b: ObjectId): Promise<ObjectId | null> {
    const aAncestors = await this.ancestorSet(a);
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (aAncestors.has(current)) return current;
      if (seen.has(current)) continue;
      seen.add(current);
      const state = await this.loadState(current);
      queue.push(...state.parents);
    }
    return null;
  }

  private async isAncestorOrSelf(ancestor: ObjectId, descendant: ObjectId): Promise<boolean> {
    return (await this.ancestorSet(descendant)).has(ancestor);
  }

  // ---- object readers ----

  async loadState(id: ObjectId): Promise<State> {
    const obj = await this.objects.read(id);
    if (!obj || obj.kind !== "state") throw new Error(`not a state: ${id}`);
    return obj;
  }

  async loadTree(id: ObjectId): Promise<Tree> {
    const obj = await this.objects.read(id);
    if (!obj || obj.kind !== "tree") throw new Error(`not a tree: ${id}`);
    return obj;
  }

  async readBlob(id: ObjectId): Promise<Uint8Array> {
    const obj = await this.objects.read(id);
    if (!obj || obj.kind !== "blob") throw new Error(`not a blob: ${id}`);
    return obj.data;
  }

  // ---- gc and fsck ----

  async gc(): Promise<GcResult> {
    const keep = await this.collectReachable();
    const cutoff = Date.now() - GC_GRACE_MS;
    const candidates: ObjectId[] = [];
    for (const id of await this.objects.list()) {
      if (keep.has(id)) continue;
      const mtime = await this.objects.mtime(id);
      if (mtime === null || mtime > cutoff) continue;
      candidates.push(id);
    }
    if (candidates.length === 0) return { removed: 0 };
    const fresh = await this.collectReachable();
    let removed = 0;
    for (const id of candidates) {
      if (fresh.has(id)) continue;
      await this.objects.remove(id);
      removed++;
    }
    return { removed };
  }

  async fsck(): Promise<FsckResult> {
    const issues: FsckIssue[] = [];
    const ids = await this.objects.list();
    let verified = 0;
    for (const id of ids) {
      const raw = await this.objects.readRaw(id);
      if (!raw) {
        issues.push({ id, problem: "missing object" });
        continue;
      }
      let obj: StoredObject;
      try {
        obj = decodeObject(raw);
      } catch {
        issues.push({ id, problem: "undecodable object" });
        continue;
      }
      if ((await hashEncoding(encodeObject(obj))) !== id) issues.push({ id, problem: "hash mismatch" });
      verified++;
    }
    const keep = await this.collectReachable();
    const unreachable = ids.filter((id) => !keep.has(id));
    return { ok: issues.length === 0, objects: verified, unreachable, issues };
  }

  /** Reachability roots: world head, layer bases and heads, all contributions, and provenance/evidence referencing reachable states. */
  private async collectReachable(): Promise<Set<string>> {
    const keep = new Set<string>();
    const markTree = async (id: ObjectId): Promise<void> => {
      if (keep.has(id)) return;
      keep.add(id);
      for (const entry of (await this.loadTree(id)).entries) {
        if (entry.kind === "tree") await markTree(entry.id);
        else keep.add(entry.id);
      }
    };
    const markState = async (id: ObjectId): Promise<void> => {
      if (keep.has(id)) return;
      keep.add(id);
      const state = await this.loadState(id);
      await markTree(state.tree);
      for (const parent of state.parents) await markState(parent);
    };
    const roots: ObjectId[] = [];
    const world = await this.worldHead();
    if (world) roots.push(world);
    for (const ref of await this.layerList()) {
      roots.push(ref.base);
      if (ref.head) roots.push(ref.head);
    }
    for (const key of await this.meta.list("contrib/")) {
      const id = objectId(key.slice("contrib/".length));
      keep.add(id);
      const contribution = await this.objects.read(id);
      if (contribution && contribution.kind === "contribution") roots.push(contribution.state, contribution.base);
    }
    for (const id of roots) {
      const obj = await this.objects.read(id);
      if (!obj) continue;
      if (obj.kind === "state") await markState(id);
      else if (obj.kind === "tree") await markTree(id);
      else keep.add(id);
    }
    for (const id of await this.objects.list()) {
      if (keep.has(id)) continue;
      const obj = await this.objects.read(id);
      if (!obj) continue;
      if (obj.kind === "provenance" && obj.states.some((s) => keep.has(s))) keep.add(id);
      else if (obj.kind === "evidence" && keep.has(obj.state)) keep.add(id);
    }
    return keep;
  }
}

export async function openRepository(rootPath: string): Promise<Repository> {
  return Repository.open(rootPath);
}

export async function init(rootPath: string): Promise<Repository> {
  return Repository.init(rootPath);
}
