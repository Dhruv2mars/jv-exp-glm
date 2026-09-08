import { isObjectId, objectId, type Commit, type ObjectId, type SerializedObject, type TreeEntry } from "@javelin/protocol";
import type { JavelinClient } from "@javelin/sdk";

export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_PART = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_FILES = 500;
const MAX_BLOB_BYTES = 512 * 1024;

export type Obj = SerializedObject;
export type ObjMap = Map<string, Obj>;

export class NotFound extends Error {}

export async function fetchObjects(client: JavelinClient, repo: string, want: string[]): Promise<ObjMap> {
  if (want.length === 0) return new Map();
  const res = await client.fetchObjects(repo, want.filter(isObjectId) as ObjectId[]);
  return new Map(res.objects.map((o) => [o.id, o]));
}

export function asCommit(o: Obj | undefined): Commit | null {
  return o !== undefined && o.kind === "commit" ? o.object : null;
}

export function asTree(o: Obj | undefined): TreeEntry[] {
  return o !== undefined && o.kind === "tree" ? o.object.entries : [];
}

/** Resolves a branch name, tag name, or raw commit id to a commit id. */
export async function resolveCommit(client: JavelinClient, repo: string, ref: string): Promise<ObjectId> {
  if (isObjectId(ref)) return ref as ObjectId;
  if (!REF_PART.test(ref) || ref.includes("..")) throw new NotFound(`invalid ref: ${ref}`);
  const { refs } = await client.listRefs(repo);
  for (const candidate of [`refs/heads/${ref}`, `refs/tags/${ref}`, ref]) {
    const id = refs[candidate!];
    if (id !== undefined) {
      const objects = await fetchObjects(client, repo, [id]);
      const commit = asCommit(objects.get(id));
      if (commit) return id as ObjectId;
      throw new NotFound(`ref ${ref} does not point at a commit`);
    }
  }
  throw new NotFound(`ref not found: ${ref}`);
}

export interface PathHit {
  kind: "tree" | "blob";
  id: ObjectId;
}

/** Walks a tree path from a commit; returns the tree or blob at that path. */
export async function lookupPath(
  client: JavelinClient,
  repo: string,
  commitId: ObjectId,
  segments: string[],
): Promise<PathHit | null> {
  const objects = await fetchObjects(client, repo, [commitId]);
  const commit = asCommit(objects.get(commitId));
  if (!commit) throw new NotFound(`commit not found: ${commitId}`);
  let id: ObjectId = commit.tree;
  let kind: PathHit["kind"] = "tree";
  for (const seg of segments) {
    if (kind !== "tree") return null;
    const entry = asTree((await fetchObjects(client, repo, [id])).get(id)).find((e) => e.name === seg);
    if (!entry) return null;
    id = entry.id;
    kind = entry.kind;
  }
  return { kind, id };
}

/** Flattens a tree into path -> blob id, breadth-first with a file cap. */
export async function listTreeFiles(
  client: JavelinClient,
  repo: string,
  treeId: ObjectId,
): Promise<Map<string, ObjectId>> {
  const files = new Map<string, ObjectId>();
  let queue: { path: string; id: ObjectId }[] = [{ path: "", id: treeId }];
  const wantBatch = async (want: { path: string; id: ObjectId }[]): Promise<ObjMap> => {
    const objects: ObjMap = new Map();
    for (let i = 0; i < want.length; i += 100) {
      const chunk = want.slice(i, i + 100).map((w) => w.id);
      for (const o of (await client.fetchObjects(repo, chunk as ObjectId[])).objects) objects.set(o.id, o);
    }
    return objects;
  };
  while (queue.length > 0 && files.size < MAX_FILES) {
    const objects = await wantBatch(queue);
    const next: { path: string; id: ObjectId }[] = [];
    for (const item of queue) {
      for (const entry of asTree(objects.get(item.id))) {
        const path = item.path ? `${item.path}/${entry.name}` : entry.name;
        if (entry.kind === "blob") files.set(path, entry.id);
        else next.push({ path, id: entry.id });
      }
    }
    queue = next;
  }
  return files;
}

export function decodeBlob(o: Obj | undefined): string | null {
  return o !== undefined && o.kind === "blob" ? o.data : null;
}
