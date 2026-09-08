import { openRepository, type Repository, type StoredObject } from "@javelin/vcs";
import { JavelinClient, JrpError } from "@javelin/sdk";
import type { ObjectId, SerializedObject } from "@javelin/protocol";
import { baseUrlFromUrl, loadConfig, repoNameFromUrl, saveConfig } from "./config";

const MAX_PUSH_ATTEMPTS = 3;

async function clientFor(root: string, remoteName: string): Promise<{ client: JavelinClient; repoName: string }> {
  const config = await loadConfig(root);
  const remote = config.remotes[remoteName];
  if (!remote) throw new Error(`no remote named '${remoteName}' configured (use 'javelin remote add')`);
  const client = new JavelinClient({ baseUrl: baseUrlFromUrl(remote.url), token: remote.token });
  return { client, repoName: repoNameFromUrl(remote.url) };
}

function toWire(id: ObjectId, obj: StoredObject): SerializedObject {
  if (obj.kind === "blob") return { id, kind: "blob", data: new TextDecoder().decode(obj.data) };
  return { id, kind: obj.kind, object: obj } as SerializedObject;
}

/** All objects reachable from the tips via locally available objects. */
async function closure(repo: Repository, tips: ObjectId[]): Promise<Set<ObjectId>> {
  const seen = new Set<ObjectId>();
  const queue = [...tips];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    const obj = await repo.objects.read(id);
    if (!obj) continue;
    seen.add(id);
    if (obj.kind === "commit") queue.push(obj.tree, ...obj.parents);
    if (obj.kind === "tree") for (const e of obj.entries) queue.push(e.id);
  }
  return seen;
}

/** True if every object reachable from the tips exists locally. */
async function closureComplete(repo: Repository, tips: ObjectId[]): Promise<ObjectId | null> {
  const seen = new Set<ObjectId>();
  const queue = [...tips];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const obj = await repo.objects.read(id);
    if (!obj) return id;
    if (obj.kind === "commit") queue.push(obj.tree, ...obj.parents);
    if (obj.kind === "tree") for (const e of obj.entries) queue.push(e.id);
  }
  return null;
}

async function listRefsOrThrow(client: JavelinClient, repoName: string, context: string): Promise<Record<string, ObjectId>> {
  try {
    return (await client.listRefs(repoName)).refs;
  } catch (e) {
    if (e instanceof JrpError && e.code === "not_found") {
      throw new Error(`repository '${repoName}' not found on remote (${context})`);
    }
    throw e;
  }
}

/** Download every object reachable from tips that the local store lacks. */
async function downloadClosure(client: JavelinClient, repoName: string, repo: Repository, tips: ObjectId[]): Promise<number> {
  let downloaded = 0;
  const enqueued = new Set<ObjectId>();
  const queue = [...tips];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (enqueued.has(id) || (await repo.objects.has(id))) continue;
    enqueued.add(id);
    const fetched = await client.fetchObjects(repoName, [id]);
    for (const s of fetched.objects) {
      await storeWire(repo, s);
      downloaded++;
      const obj = s.kind === "blob" ? null : s.object;
      if (obj?.kind === "commit") queue.push(obj.tree, ...obj.parents);
      if (obj?.kind === "tree") for (const e of obj.entries) queue.push(e.id);
    }
  }
  return downloaded;
}

async function storeWire(repo: Repository, s: SerializedObject): Promise<void> {
  if (s.kind === "blob") {
    await repo.objects.write({ kind: "blob", data: new TextEncoder().encode(s.data) });
  } else {
    await repo.objects.write(s.object as StoredObject);
  }
}

export async function cmdRemoteAdd(root: string, name: string, url: string, token?: string): Promise<string> {
  const config = await loadConfig(root);
  if (config.remotes[name]) throw new Error(`remote '${name}' already exists`);
  config.remotes[name] = token === undefined ? { url } : { url, token };
  await saveConfig(root, config);
  return `added remote '${name}' -> ${url}`;
}

export async function cmdPush(root: string, remoteName = "origin", branch?: string): Promise<string> {
  const repo = await openRepository(root);
  const { client, repoName } = await clientFor(root, remoteName);
  const branchName = branch ?? (await repo.currentBranch());
  const localRef = `refs/heads/${branchName}`;
  const localTip = await repo.refs.get(localRef);
  if (!localTip) throw new Error(`branch '${branchName}' has no commits`);

  let lastDetail = "";
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    let remoteRefs: Record<string, ObjectId>;
    try {
      remoteRefs = (await client.listRefs(repoName)).refs;
    } catch (e) {
      if (e instanceof JrpError && e.code === "not_found") {
        await client.createRepo({ name: repoName });
        remoteRefs = {};
      } else {
        throw e;
      }
    }
    const remoteTip = remoteRefs[localRef] ?? null;
    if (remoteTip === localTip) return "everything up to date";

    const dangling = await closureComplete(repo, Object.values(remoteRefs));
    if (dangling) {
      // A remote tip whose objects we lack cannot be an ancestor of our tip, so the server would
      // reject this update as non-fast-forward.
      throw new Error(`push rejected (non-fast-forward): remote history references object ${dangling} missing locally; run 'javelin fetch ${remoteName}' first`);
    }
    const remoteHave = await closure(repo, Object.values(remoteRefs));
    const localHave = await closure(repo, [localTip]);
    const missing = [...localHave].filter((id) => !remoteHave.has(id));

    if (missing.length > 0) {
      const objects: SerializedObject[] = [];
      for (const id of missing) {
        const obj = await repo.objects.read(id);
        if (obj) objects.push(toWire(id, obj));
      }
      const res = await client.uploadObjects(repoName, objects);
      if (res.rejected.length > 0) {
        throw new Error(`server rejected ${res.rejected.length} object(s): ${res.rejected.map((r) => `${r.id}: ${r.reason}`).join("; ")}`);
      }
    }

    const update = await client.updateRefs(repoName, [{ ref: localRef, expectedOld: remoteTip, new: localTip }]);
    const result = update.results[0];
    if (!result) throw new Error("server returned no ref update result");
    if (result.ok) {
      return `pushed ${branchName} -> ${remoteName}/${repoName} (${missing.length} object${missing.length === 1 ? "" : "s"})`;
    }
    lastDetail = result.detail ?? result.reason ?? "unknown error";
    if (result.reason === "non-fast-forward") throw new Error(`push rejected (non-fast-forward): ${lastDetail}`);
    if (result.reason !== "cas-mismatch") throw new Error(`push failed: ${lastDetail}`);
  }
  throw new Error(`push failed after ${MAX_PUSH_ATTEMPTS} attempts (concurrent updates): ${lastDetail}`);
}

export async function cmdFetch(root: string, remoteName = "origin"): Promise<string> {
  const repo = await openRepository(root);
  const { client, repoName } = await clientFor(root, remoteName);
  const remoteRefs = await listRefsOrThrow(client, repoName, "fetch");

  const heads = Object.entries(remoteRefs).filter(([ref]) => ref.startsWith("refs/heads/"));
  const downloaded = await downloadClosure(client, repoName, repo, heads.map(([, id]) => id));

  let updated = 0;
  for (const [ref, id] of heads) {
    const local = `refs/remotes/${remoteName}/${ref.slice("refs/heads/".length)}`;
    const current = await repo.refs.get(local);
    if (current === id) continue;
    const result = await repo.refs.set(local, id, current);
    if (!result.ok) throw new Error(`failed to update ${local}: ${result.detail}`);
    updated++;
  }
  return `fetched ${remoteName}/${repoName}: ${downloaded} object(s), ${updated} ref(s) updated`;
}

export async function cmdPull(root: string, remoteName = "origin", branch?: string): Promise<string> {
  await cmdFetch(root, remoteName);
  const repo = await openRepository(root);
  const branchName = branch ?? (await repo.currentBranch());
  const remoteRef = `refs/remotes/${remoteName}/${branchName}`;
  if (!(await repo.refs.get(remoteRef))) throw new Error(`no remote branch ${remoteRef}`);
  const result = await repo.mergeBranch(remoteRef);
  if (!result.ok) {
    throw new Error(`merge failed with ${result.conflicts.length} conflict(s): ${result.conflicts.map((c) => c.path).join(", ")}`);
  }
  if (result.commitId === null) throw new Error("merge produced no commit");
  const commit = await repo.loadCommit(result.commitId);
  return commit.parents.length > 1 ? `merged ${remoteRef} as ${result.commitId}` : "already up to date";
}

export async function cmdClone(url: string, dir?: string): Promise<string> {
  const repoName = repoNameFromUrl(url);
  const target = dir ?? repoName;
  const repo = await openRepository(target);
  const token = process.env.JAVELIN_TOKEN;
  await cmdRemoteAdd(target, "origin", url, token);

  const client = new JavelinClient({ baseUrl: baseUrlFromUrl(url), token });
  const remoteRefs = await listRefsOrThrow(client, repoName, "clone");
  const heads = Object.entries(remoteRefs).filter(([ref]) => ref.startsWith("refs/heads/"));
  if (heads.length === 0) throw new Error(`no branches on ${repoName}`);

  await downloadClosure(client, repoName, repo, heads.map(([, id]) => id));
  for (const [ref, id] of heads) {
    const local = `refs/remotes/origin/${ref.slice("refs/heads/".length)}`;
    await repo.refs.set(local, id, await repo.refs.get(local));
  }
  const preferred = heads.find(([ref]) => ref === "refs/heads/main") ?? heads[0]!;
  const branch = preferred[0].slice("refs/heads/".length);
  const headResult = await repo.refs.set(`refs/heads/${branch}`, preferred[1]);
  if (!headResult.ok) throw new Error(`failed to create local branch ${branch}: ${headResult.detail}`);
  await repo.setHeadBranch(branch);
  await repo.checkout(branch);
  return `cloned ${repoName} into ${target} (branch ${branch})`;
}
