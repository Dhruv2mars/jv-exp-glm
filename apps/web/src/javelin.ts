import { decodeBase64, isObjectId, objectId, type ObjectId, type WireObject, type HeadsView } from "@javelin/sdk";
import type { JavelinClient } from "@javelin/sdk";

// packages/protocol does not re-export ./model yet, so derive the domain shapes
// the same way packages/sdk does: from the authoritative WireObject union.
export type State = Extract<WireObject, { kind: "state" }>["object"];
export type Tree = Extract<WireObject, { kind: "tree" }>["object"];
export type TreeEntry = Tree["entries"][number];
export type LayerRef = HeadsView["layers"][number];
export type Person = State["author"];
export type Contribution = Extract<WireObject, { kind: "contribution" }>["object"];

const MAX_FILES = 2000;

export class NotFound extends Error {}

export type ObjMap = Map<ObjectId, WireObject>;

/** Bulk-fetch wire objects; the caller narrows kinds with asState/asTree/blobBytes. */
export async function fetchObjects(client: JavelinClient, repo: string, ids: ObjectId[]): Promise<ObjMap> {
  if (ids.length === 0) return new Map();
  const res = await client.batchFetch(repo, ids);
  return new Map(res.objects.map((o) => [o.id, o]));
}

export function asState(o: WireObject | undefined): State | null {
  return o !== undefined && o.kind === "state" ? o.object : null;
}

export function asTree(o: WireObject | undefined): Tree | null {
  return o !== undefined && o.kind === "tree" ? o.object : null;
}

export function asContribution(o: WireObject | undefined): Contribution | null {
  return o !== undefined && o.kind === "contribution" ? o.object : null;
}

export function blobBytes(o: WireObject | undefined): Uint8Array | null {
  return o !== undefined && o.kind === "blob" ? decodeBase64(o.data) : null;
}

/** "world" or "layer/<name>" — the only browse-able refs in the v2 model. */
export type RefSpec = "world" | `layer/${string}`;

export function parseRefSpec(raw: string): RefSpec | null {
  if (raw === "world") return "world";
  if (raw.startsWith("layer/") && raw.length > "layer/".length) return raw as RefSpec;
  return null;
}

export function refHead(heads: HeadsView, ref: RefSpec): ObjectId | null {
  if (ref === "world") return heads.world;
  return heads.layers.find((l) => `layer/${l.name}` === ref)?.head ?? null;
}

export function refBase(heads: HeadsView, ref: RefSpec): ObjectId | null {
  if (ref === "world") return heads.world;
  const layer = heads.layers.find((l) => `layer/${l.name}` === ref);
  return layer ? (layer.head ?? layer.base) : null;
}

export interface FlatFile {
  id: ObjectId;
  mode: TreeEntry["mode"];
}

/** Flattens a tree into path -> entry, breadth-first with a file cap. */
export async function flattenTree(client: JavelinClient, repo: string, treeId: ObjectId): Promise<Map<string, FlatFile>> {
  const files = new Map<string, FlatFile>();
  let queue: { path: string; id: ObjectId }[] = [{ path: "", id: treeId }];
  while (queue.length > 0 && files.size < MAX_FILES) {
    const objects = await fetchObjects(client, repo, queue.map((q) => q.id));
    const next: { path: string; id: ObjectId }[] = [];
    for (const item of queue) {
      const tree = asTree(objects.get(item.id));
      if (!tree) continue;
      for (const entry of tree.entries) {
        const path = item.path ? `${item.path}/${entry.name}` : entry.name;
        if (entry.kind === "tree") next.push({ path, id: entry.id });
        else files.set(path, { id: entry.id, mode: entry.mode });
      }
    }
    queue = next;
  }
  return files;
}

/** Paths added, removed, or whose blob id changed between two flattened trees. */
export function treeDiff(before: Map<string, FlatFile>, after: Map<string, FlatFile>): string[] {
  const changed: string[] = [];
  for (const [path, file] of after) {
    if (before.get(path)?.id !== file.id) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(path);
  }
  return changed.sort();
}

/** A blob is binary when it contains a NUL byte in its leading window. */
export function isBinary(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 8000);
  return window.includes(0);
}

export function parseObjectId(raw: string): ObjectId | null {
  return isObjectId(raw) ? objectId(raw) : null;
}

const KIND_PREFIX: Record<string, number> = { blob: 0x01, tree: 0x02, state: 0x03, provenance: 0x05, evidence: 0x06, contribution: 0x07 };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Content address of a structured object, matching the server-side hashing. */
export async function objectIdOf(obj: Exclude<WireObject, { kind: "blob" }>["object"]): Promise<ObjectId> {
  const body = new TextEncoder().encode(canonicalJson(obj));
  const encoding = new Uint8Array(1 + body.length);
  encoding[0] = KIND_PREFIX[obj.kind]!;
  encoding.set(body, 1);
  const digest = await crypto.subtle.digest("SHA-256", encoding as BufferSource);
  return objectId([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}
