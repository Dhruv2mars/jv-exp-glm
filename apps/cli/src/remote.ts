import {
  decodeWireBlob,
  encodeWireBlob,
  isObjectId,
  MAX_OBJECT_BYTES,
  objectId,
  type BatchFetchResponse,
  type ObjectId,
  type WireObject,
} from "@javelin/protocol";
import { JavelinClient, JrpError, type Contribution, type HeadsView } from "@javelin/sdk";
import type { ContributionEvent, ContributionStatus, State } from "@javelin/protocol";
import {
  diff3,
  encodeObject,
  hashEncoding,
  joinLines,
  makeTree,
  openRepository,
  Repository,
  splitLines,
  type Author,
  type ContributionMeta,
  type FileEntry,
  type FileMap,
  type MergeConflict,
  type Repository as Repo,
} from "@javelin/vcs";
import { baseUrlFromUrl, loadConfig, repoNameFromUrl, saveConfig } from "./config";
import { flattenTree, formatConflicts, listLocalContributions, resolveAuthor, worldValue } from "./shared";

const MAX_PUBLISH_ATTEMPTS = 3;
const UPLOAD_BATCH_OBJECTS = 200;
const UPLOAD_BATCH_BYTES = 8 * 1024 * 1024;
const FETCH_BATCH_OBJECTS = 128;

async function clientFor(root: string, remoteName: string): Promise<{ client: JavelinClient; repoName: string }> {
  const config = await loadConfig(root);
  const remote = config.remotes[remoteName];
  if (!remote) throw new Error(`no remote named '${remoteName}' configured (use 'javelin remote add')`);
  return {
    client: new JavelinClient({ baseUrl: baseUrlFromUrl(remote.url), token: remote.token }),
    repoName: repoNameFromUrl(remote.url),
  };
}

async function getHeadsSafe(client: JavelinClient, repoName: string, context: string): Promise<HeadsView> {
  try {
    return await client.getHeads(repoName);
  } catch (e) {
    if (e instanceof JrpError && e.code === "not_found") {
      throw new Error(`repository '${repoName}' not found on remote (${context})`);
    }
    throw e;
  }
}

/** Create the remote repo on first contact; a racing create is fine. */
async function ensureRepo(client: JavelinClient, repoName: string): Promise<void> {
  try {
    await client.getHeads(repoName);
    return;
  } catch (e) {
    if (!(e instanceof JrpError) || e.code !== "not_found") throw e;
  }
  try {
    await client.createRepo({ name: repoName });
  } catch (e) {
    if (!(e instanceof JrpError) || e.code !== "conflict") throw e;
  }
}

// ---- wire transfer ----

function refsOfWire(wire: WireObject): ObjectId[] {
  if (wire.kind === "blob") return [];
  const obj = wire.object;
  if (obj.kind === "state") return [obj.tree, ...obj.parents];
  if (obj.kind === "tree") return obj.entries.map((e) => e.id);
  if (obj.kind === "contribution") return [obj.state, obj.base];
  if (obj.kind === "provenance") return [...obj.states];
  if (obj.kind === "evidence") return [obj.state];
  return [];
}

async function storeWire(repo: Repo, wire: WireObject): Promise<void> {
  if (wire.kind === "blob") await repo.objects.write({ kind: "blob", data: decodeWireBlob(wire) });
  else await repo.objects.write(wire.object);
}

/** Fetch a batch, splitting down to single ids when one oversized blob poisons the JSON batch. */
async function fetchChunk(client: JavelinClient, repoName: string, ids: ObjectId[]): Promise<BatchFetchResponse> {
  try {
    return await client.batchFetch(repoName, ids);
  } catch (e) {
    if (!(e instanceof JrpError) || e.code !== "payload_too_large") throw e;
    if (ids.length === 1) return { objects: [], missing: ids };
    const objects: WireObject[] = [];
    const missing: ObjectId[] = [];
    for (const id of ids) {
      const one = await fetchChunk(client, repoName, [id]);
      objects.push(...one.objects);
      missing.push(...one.missing);
    }
    return { objects, missing };
  }
}

async function fetchRawBlob(client: JavelinClient, repoName: string, id: ObjectId): Promise<Uint8Array | null> {
  try {
    const bytes = await client.getRawBlob(repoName, id);
    const hashed = await hashEncoding(encodeObject({ kind: "blob", data: bytes }));
    return hashed === id ? bytes : null;
  } catch {
    return null;
  }
}

/** Download every object reachable from tips that the local store lacks, raw endpoints included. */
async function downloadObjects(client: JavelinClient, repoName: string, repo: Repo, tips: (ObjectId | null)[]): Promise<number> {
  let downloaded = 0;
  let frontier = tips.filter((t): t is ObjectId => t !== null);
  while (frontier.length > 0) {
    const want: ObjectId[] = [];
    for (const id of frontier) if (!(await repo.objects.has(id))) want.push(id);
    frontier = [];
    if (want.length === 0) break;
    for (let i = 0; i < want.length; i += FETCH_BATCH_OBJECTS) {
      const chunk = want.slice(i, i + FETCH_BATCH_OBJECTS);
      const { objects, missing } = await fetchChunk(client, repoName, chunk);
      for (const wire of objects) {
        await storeWire(repo, wire);
        downloaded++;
      }
      for (const id of missing) {
        const blob = await fetchRawBlob(client, repoName, id);
        if (blob) {
          await repo.objects.write({ kind: "blob", data: blob });
          downloaded++;
        }
      }
      for (const wire of objects) frontier.push(...refsOfWire(wire));
    }
  }
  return downloaded;
}

/** All object ids reachable from tips through locally available objects. */
async function collectLocalClosure(repo: Repo, tips: (ObjectId | null)[]): Promise<ObjectId[]> {
  const seen = new Set<string>();
  const order: ObjectId[] = [];
  const queue = tips.filter((t): t is ObjectId => t !== null);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const obj = await repo.objects.read(id);
    if (!obj) continue;
    order.push(id);
    if (obj.kind === "state") queue.push(obj.tree, ...obj.parents);
    else if (obj.kind === "tree") for (const e of obj.entries) queue.push(e.id);
    else if (obj.kind === "contribution") queue.push(obj.state, obj.base);
    else if (obj.kind === "provenance") queue.push(...obj.states);
    else if (obj.kind === "evidence") queue.push(obj.state);
  }
  return order;
}

/** Upload missing-from-remote candidates; content addressing makes re-uploads harmless. */
async function uploadClosure(client: JavelinClient, repoName: string, repo: Repo, tips: (ObjectId | null)[]): Promise<number> {
  let uploaded = 0;
  let batch: WireObject[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const res = await client.batchUpload(repoName, batch);
    if (res.rejected.length > 0) {
      throw new Error(`remote rejected ${res.rejected.length} object(s): ${res.rejected.map((r) => `${r.id}: ${r.reason}`).join("; ")}`);
    }
    uploaded += batch.length;
    batch = [];
    batchBytes = 0;
  };
  for (const id of await collectLocalClosure(repo, tips)) {
    const obj = await repo.objects.read(id);
    if (!obj) continue;
    let wire: WireObject;
    let size: number;
    if (obj.kind === "blob") {
      if (obj.data.byteLength > MAX_OBJECT_BYTES) {
        await flush();
        await client.putRawBlob(repoName, id, new Uint8Array(obj.data));
        uploaded++;
        continue;
      }
      wire = encodeWireBlob(id, obj.data);
      size = wire.data.length;
    } else {
      wire = { id, kind: obj.kind, object: obj } as WireObject;
      size = JSON.stringify(wire).length;
    }
    if (batch.length >= UPLOAD_BATCH_OBJECTS || batchBytes + size > UPLOAD_BATCH_BYTES) await flush();
    batch.push(wire);
    batchBytes += size;
  }
  await flush();
  return uploaded;
}

// ---- state algebra the CLI needs for remote publishes (Repository keeps these private) ----

async function ancestorSet(repo: Repo, id: ObjectId): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    queue.push(...(await repo.loadState(cur)).parents);
  }
  return seen;
}

async function mergeBase(repo: Repo, a: ObjectId, b: ObjectId): Promise<ObjectId | null> {
  const aAncestors = await ancestorSet(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (aAncestors.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    queue.push(...(await repo.loadState(cur)).parents);
  }
  return null;
}

async function buildTree(repo: Repo, files: FileMap): Promise<ObjectId> {
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
      if (value instanceof Map) entries.push({ name, mode: "file" as const, kind: "tree" as const, id: await writeDir(value) });
      else entries.push({ name, mode: value.mode, kind: "blob" as const, id: value.id });
    }
    return (await repo.objects.write(makeTree(entries))).id;
  };
  return writeDir(root);
}

/** Port of Repository's three-way tree merge; needed here because the merge target is a remote world head. */
async function mergeWorldTrees(
  repo: Repo,
  baseState: ObjectId | null,
  ours: ObjectId,
  theirs: ObjectId,
): Promise<{ files: FileMap | null; conflicts: MergeConflict[] }> {
  const [baseFiles, oursFiles, theirsFiles] = await Promise.all([
    baseState ? flattenTree(repo, baseState) : Promise.resolve({} as FileMap),
    flattenTree(repo, ours),
    flattenTree(repo, theirs),
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
    const mode = o.mode !== b.mode ? o.mode : t.mode;
    const decode = async (id: ObjectId): Promise<string[]> => splitLines(new TextDecoder().decode(await repo.readBlob(id)));
    const [baseLines, ourLines, theirLines] = await Promise.all([decode(b.id), decode(o.id), decode(t.id)]);
    const merged = diff3(baseLines, ourLines, theirLines);
    if (!merged.lines) {
      conflicts.push({ path, kind: "content", baseId: b.id, oursId: o.id, theirsId: t.id });
      continue;
    }
    const blob = { kind: "blob" as const, data: joinLines(merged.lines) };
    files[path] = { id: (await repo.objects.write(blob)).id, mode };
  }
  return conflicts.length > 0 ? { files: null, conflicts } : { files, conflicts: [] };
}

// ---- remote-tracking meta ----

async function trackMeta(repo: Repo, key: string, value: string | null): Promise<void> {
  const full = `remote/${key}`;
  if (value === null) {
    await repo.meta.delete(full);
    return;
  }
  const raw = await repo.meta.get(full);
  const moved =
    raw === null ? await repo.meta.create(full, value) : (await repo.meta.compareAndSwap(full, raw, value)).ok;
  if (!moved) throw new Error(`failed to update remote-tracking meta ${full}`);
}

function headTips(heads: HeadsView): (ObjectId | null)[] {
  return [heads.world, ...heads.layers.flatMap((l) => [l.base, l.head] as (ObjectId | null)[])];
}

/**
 * True for the untouched initial world state (no parents, empty tree). Accepting a remote
 * world over it loses nothing, because it never held accepted content and independent
 * repos have unrelated init states by construction.
 */
async function isEmptyRoot(repo: Repo, stateId: ObjectId): Promise<boolean> {
  const state = await repo.loadState(stateId);
  if (state.parents.length > 0) return false;
  return Object.keys(await flattenTree(repo, stateId)).length === 0;
}

// ---- commands ----

export async function cmdRemoteAdd(root: string, name: string, url: string, token?: string): Promise<string> {
  const config = await loadConfig(root);
  if (config.remotes[name]) throw new Error(`remote '${name}' already exists`);
  config.remotes[name] = token === undefined ? { url } : { url, token };
  await saveConfig(root, config);
  return `added remote '${name}' -> ${url}`;
}

/**
 * Download remote objects and record them under meta/remote/<name>/…
 * Local world and layer heads are never touched; `pull` reconciles those.
 */
export async function cmdFetch(root: string, remoteName = "origin"): Promise<string> {
  const repo = await openRepository(root);
  const { client, repoName } = await clientFor(root, remoteName);
  const heads = await getHeadsSafe(client, repoName, "fetch");
  const downloaded = await downloadObjects(client, repoName, repo, headTips(heads));
  await trackMeta(repo, `${remoteName}/world`, heads.world);
  for (const l of heads.layers) await trackMeta(repo, `${remoteName}/layer/${l.name}`, JSON.stringify(l));
  return `fetched ${remoteName}/${repoName}: ${downloaded} object(s); remote-tracking meta updated (local world and layers untouched)`;
}

async function trackedWorld(repo: Repo, remoteName: string): Promise<ObjectId | null> {
  const raw = await repo.meta.get(`remote/${remoteName}/world`);
  return raw !== null && isObjectId(raw) ? objectId(raw) : null;
}

/** fetch + fast-forward the world head + refresh the current layer (or materialize world). */
export async function cmdPull(root: string, remoteName = "origin"): Promise<string> {
  await cmdFetch(root, remoteName);
  const repo = await openRepository(root);
  const lines: string[] = [];
  const remoteWorld = await trackedWorld(repo, remoteName);
  const localWorld = await repo.worldHead();
  if (remoteWorld !== null && remoteWorld !== localWorld) {
    const safe =
      localWorld === null ||
      (await isEmptyRoot(repo, localWorld)) ||
      (await ancestorSet(repo, remoteWorld)).has(localWorld);
    if (!safe) {
      throw new Error(`local world has diverged from ${remoteName}/${remoteWorld}; publish your work or re-clone`);
    }
    const raw = await repo.meta.get("world");
    const moved = await repo.meta.compareAndSwap("world", raw!, worldValue(remoteWorld));
    if (!moved.ok) throw new Error("world head moved during pull; retry");
    lines.push(`world: ${localWorld} -> ${remoteWorld}`);
  } else {
    lines.push("world already up to date");
  }
  const current = await repo.currentLayer();
  if (current === "world") {
    const world = await repo.worldHead();
    if (world) await repo.materialize(world);
    lines.push("working tree updated to the world head");
    return lines.join("\n");
  }
  const ref = await repo.layerGet(current);
  if (!ref) throw new Error(`no such layer: ${current}`);
  if (!ref.head) {
    lines.push(`layer ${current} has no checkpoints; working tree unchanged`);
    return lines.join("\n");
  }
  const result = await repo.refresh(current);
  if (!result.ok) {
    throw new Error(`refresh failed with ${result.conflicts.length} conflict(s):\n${formatConflicts(result.conflicts)}`);
  }
  if (result.stateId === null) lines.push(`layer ${current} already contains the world head`);
  else lines.push(`refreshed layer ${current} at ${result.stateId}`);
  return lines.join("\n");
}

export async function cmdClone(url: string, dir?: string): Promise<string> {
  const repoName = repoNameFromUrl(url);
  const target = dir ?? repoName;
  const token = process.env.JAVELIN_TOKEN;
  const repo = await Repository.init(target);
  await cmdRemoteAdd(target, "origin", url, token);
  const client = new JavelinClient({ baseUrl: baseUrlFromUrl(url), token });
  const heads = await getHeadsSafe(client, repoName, "clone");
  const downloaded = await downloadObjects(client, repoName, repo, headTips(heads));
  if (heads.world) {
    const raw = await repo.meta.get("world");
    const moved = await repo.meta.compareAndSwap("world", raw!, worldValue(heads.world));
    if (!moved.ok) throw new Error("failed to set the world head during clone");
    await repo.materialize(heads.world);
  }
  await trackMeta(repo, "origin/world", heads.world);
  for (const l of heads.layers) await trackMeta(repo, `origin/layer/${l.name}`, JSON.stringify(l));
  return `cloned ${repoName} into ${target}: ${downloaded} object(s), world ${heads.world ?? "empty"}`;
}

/**
 * Plumbing sync: upload every object reachable from local heads, fast-forward the remote
 * world only when the remote history is an ancestor of ours (world advances through
 * publish, never by clobber), CAS layer heads, and mirror contribution statuses.
 */
export async function cmdPush(root: string, remoteName = "origin"): Promise<string> {
  const repo = await openRepository(root);
  const { client, repoName } = await clientFor(root, remoteName);
  await ensureRepo(client, repoName);
  const remoteHeads = await client.getHeads(repoName);
  const layers = await repo.layerList();
  const contributions = await listLocalContributions(repo);
  const tips: (ObjectId | null)[] = [
    await repo.worldHead(),
    ...layers.flatMap((l) => [l.base, l.head] as (ObjectId | null)[]),
    ...contributions.flatMap((c) => [c.id, c.contribution.state, c.contribution.base] as (ObjectId | null)[]),
  ];
  const uploaded = await uploadClosure(client, repoName, repo, tips);
  const lines = [`pushed ${uploaded} object(s) to ${remoteName}/${repoName}`];

  if (remoteHeads.world) await downloadObjects(client, repoName, repo, [remoteHeads.world]);
  const localWorld = await repo.worldHead();
  if (localWorld !== null && localWorld !== remoteHeads.world) {
    const fastForward = remoteHeads.world === null || (await ancestorSet(repo, localWorld)).has(remoteHeads.world);
    if (fastForward) {
      const r = (await client.updateHeads(repoName, [{ key: "world", expected: remoteHeads.world, next: localWorld }]))[0]!;
      lines.push(r.ok ? `world -> ${localWorld}` : `world not updated: ${r.reason}`);
    } else {
      lines.push("world not updated: local and remote world histories diverged (use publish/pull)");
    }
  } else {
    lines.push("world up to date");
  }

  const remoteLayerByName = new Map(remoteHeads.layers.map((l) => [l.name, l]));
  for (const layer of layers) {
    if (!layer.head) continue;
    const expected = remoteLayerByName.get(layer.name)?.head ?? null;
    if (expected === layer.head) continue;
    const r = (
      await client.updateHeads(repoName, [{ key: `layer/${layer.name}`, expected, next: layer.head }])
    )[0]!;
    lines.push(r.ok ? `layer ${layer.name} -> ${layer.head}` : `layer ${layer.name} not updated: ${r.reason}`);
  }

  for (const c of contributions) {
    const remoteStatus = await ensureRemoteContribution(client, repoName, c.id, c.contribution);
    if (remoteStatus !== "open" || c.meta.status === "open") continue;
    const worldState = [...c.meta.events].reverse().find((e) => e.worldState !== undefined)?.worldState;
    if (c.meta.status === "published") {
      if (worldState === undefined) continue;
      const r = await client.updateContributionStatus(repoName, c.id, {
        expected: "open",
        next: { status: "published", worldState },
      });
      lines.push(r.ok ? `contribution ${c.id} published on remote` : `contribution ${c.id} not updated: ${r.reason}`);
    } else {
      const r = await client.updateContributionStatus(repoName, c.id, { expected: "open", next: { status: "discarded" } });
      lines.push(r.ok ? `contribution ${c.id} discarded on remote` : `contribution ${c.id} not updated: ${r.reason}`);
    }
  }
  return lines.join("\n");
}

async function ensureRemoteContribution(
  client: JavelinClient,
  repoName: string,
  id: ObjectId,
  contribution: Contribution,
): Promise<ContributionStatus> {
  let page = await client.listContributions(repoName);
  let mine = page.contributions.find((c) => c.id === id);
  while (!mine && page.nextCursor !== undefined) {
    page = await client.listContributions(repoName, { cursor: page.nextCursor });
    mine = page.contributions.find((c) => c.id === id);
  }
  if (mine) return mine.status;
  await client.createContribution(repoName, contribution);
  return "open";
}

async function closeRemoteContribution(client: JavelinClient, repoName: string, id: ObjectId, worldState: ObjectId): Promise<void> {
  const res = await client.updateContributionStatus(repoName, id, { expected: "open", next: { status: "published", worldState } });
  if (res.ok) return;
  const page = await client.listContributions(repoName);
  const mine = page.contributions.find((c) => c.id === id);
  if (!mine || mine.status !== "published") {
    throw new Error(`remote refused contribution status update (${res.reason})`);
  }
}

async function markLocalContribution(repo: Repo, id: ObjectId, by: string, worldState: ObjectId): Promise<void> {
  const key = `contrib/${id}`;
  const raw = await repo.meta.get(key);
  if (!raw) return;
  const meta = JSON.parse(raw) as ContributionMeta;
  if (meta.status !== "open") return;
  const event: ContributionEvent = { status: "published", at: new Date().toISOString(), by, worldState };
  await repo.meta.compareAndSwap(key, raw, JSON.stringify({ ...meta, status: "published", events: [...meta.events, event] }));
}

export async function cmdPublish(root: string, idArg: string, remoteName?: string): Promise<string> {
  if (!isObjectId(idArg)) throw new Error(`invalid contribution id: ${idArg}`);
  const id = objectId(idArg);
  const repo = await openRepository(root);
  const found = await repo.contribution(id);
  if (!found) throw new Error(`no such contribution: ${id}`);
  const { contribution } = found;
  const localRaw = await repo.meta.get(`contrib/${id}`);
  if (localRaw) {
    const meta = JSON.parse(localRaw) as ContributionMeta;
    if (meta.status === "published") return `contribution ${id} is already published`;
    if (meta.status !== "open") throw new Error(`contribution ${id} is ${meta.status}; only open contributions can be published`);
  }
  const author = resolveAuthor();
  const config = await loadConfig(root);
  const target = remoteName ?? (config.remotes["origin"] ? "origin" : undefined);
  if (!target) {
    const result = await repo.publish(id, author);
    if (!result.ok) {
      if (result.reason === "conflict") {
        throw new Error(`publish failed with ${result.conflicts.length} conflict(s):\n${formatConflicts(result.conflicts)}`);
      }
      throw new Error(`publish failed: ${result.reason}`);
    }
    if (result.idempotent) return `contribution ${id} already published (world ${result.worldState})`;
    return `published ${id} to world ${result.worldState}`;
  }
  return publishViaRemote(repo, id, contribution, target, author);
}

async function publishViaRemote(
  repo: Repo,
  id: ObjectId,
  contribution: Contribution,
  target: string,
  author: Author,
): Promise<string> {
  const { client, repoName } = await clientFor(repo.root, target);
  await ensureRepo(client, repoName);
  let lastReason = "unknown";
  for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
    const heads = await getHeadsSafe(client, repoName, "publish");
    const world = heads.world;
    if (world !== null) await downloadObjects(client, repoName, repo, [world]);
    const remoteStatus = await ensureRemoteContribution(client, repoName, id, contribution);
    if (remoteStatus === "published") {
      await markLocalContribution(repo, id, author.name, world ?? contribution.state);
      return `contribution ${id} is already published on ${target}/${repoName}`;
    }
    if (remoteStatus === "discarded") throw new Error(`contribution ${id} is discarded on ${target}/${repoName}`);
    if (world === contribution.state) {
      await closeRemoteContribution(client, repoName, id, world);
      await markLocalContribution(repo, id, author.name, world);
      return `published ${id}: layer ${contribution.layer} is already the world head (${world})`;
    }
    if (world === null) throw new Error(`remote ${target}/${repoName} has no world head`);
    // A null base covers unrelated histories (publishing to a fresh remote): the merge runs
    // against an empty base and same-path add-add collisions still surface as conflicts.
    const base: ObjectId | null =
      (await ancestorSet(repo, world)).has(contribution.base) ? contribution.base : await mergeBase(repo, contribution.state, world);
    const { files, conflicts } = await mergeWorldTrees(repo, base, contribution.state, world);
    if (!files) {
      throw new Error(`publish failed with ${conflicts.length} conflict(s) against the remote world:\n${formatConflicts(conflicts)}`);
    }
    const merged: State = {
      kind: "state",
      tree: await buildTree(repo, files),
      parents: [world, contribution.state],
      author: { name: author.name, email: author.email, time: new Date().toISOString() },
      message: `publish ${contribution.layer}: ${contribution.title}`,
    };
    const mergedId = (await repo.objects.write(merged)).id;
    await uploadClosure(client, repoName, repo, [mergedId, contribution.state]);
    const result = (await client.updateHeads(repoName, [{ key: "world", expected: world, next: mergedId }]))[0]!;
    if (result.ok) {
      await closeRemoteContribution(client, repoName, id, mergedId);
      await markLocalContribution(repo, id, author.name, mergedId);
      let suffix = "";
      const localWorldRaw = await repo.meta.get("world");
      if (localWorldRaw !== null && localWorldRaw !== worldValue(mergedId)) {
        const moved = await repo.meta.compareAndSwap("world", localWorldRaw, worldValue(mergedId));
        if (moved.ok) {
          const ref = await repo.layerGet(contribution.layer);
          if (ref && ref.base === world) {
            const layerKey = `layer/${contribution.layer}`;
            const layerRaw = await repo.meta.get(layerKey);
            if (layerRaw) {
              const updated = JSON.stringify({ ...ref, base: mergedId, updatedAt: new Date().toISOString() });
              await repo.meta.compareAndSwap(layerKey, layerRaw, updated);
            }
          }
          suffix = "; local world advanced";
        } else {
          suffix = "; local world moved during publish — pull to sync";
        }
      }
      return `published ${id} to ${target}/${repoName} (world ${mergedId})${attempt > 1 ? ` after ${attempt} attempts` : ""}${suffix}`;
    }
    if (result.reason !== "cas-mismatch") throw new Error(`publish failed: ${result.reason}`);
    lastReason = result.reason;
  }
  throw new Error(`world moved on ${target}/${repoName} during publish (${lastReason}); ${MAX_PUBLISH_ATTEMPTS} attempts exhausted — pull, refresh, and retry`);
}
