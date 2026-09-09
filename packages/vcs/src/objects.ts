import type { Contribution, EvidenceRecord, ObjectId, ProvenanceRecord, State, Tree, TreeEntry } from "../../protocol/src/model";
import { objectId } from "@javelin/protocol";

const SHA256_ALGO = "SHA-256";
const HEX = 16;

/** In-memory blob; the protocol type leaves the payload to the transport. */
export interface BlobObject {
  kind: "blob";
  data: Uint8Array;
}

export type StoredObject = BlobObject | Tree | State | ProvenanceRecord | EvidenceRecord | Contribution;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const KIND_PREFIX: Record<string, number> = {
  blob: 0x01,
  tree: 0x02,
  state: 0x03,
  provenance: 0x05,
  evidence: 0x06,
  contribution: 0x07,
};

const PREFIX_KIND: Record<number, string> = Object.fromEntries(
  Object.entries(KIND_PREFIX).map(([k, v]) => [v, k]),
);

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(HEX).padStart(2, "0")).join("");
}

export function encodeObject(obj: StoredObject): Uint8Array {
  const kind = obj.kind;
  const prefix = KIND_PREFIX[kind];
  if (prefix === undefined) throw new Error(`unknown object kind: ${kind}`);
  const body =
    kind === "blob" ? (obj as { kind: "blob"; data: Uint8Array }).data : new TextEncoder().encode(canonicalJson(obj));
  const out = new Uint8Array(1 + body.length);
  out[0] = prefix;
  out.set(body, 1);
  return out;
}

export function decodeObject(encoding: Uint8Array): StoredObject {
  const prefix = encoding[0];
  if (prefix === undefined) throw new Error("empty object encoding");
  const kind = PREFIX_KIND[prefix];
  if (!kind) throw new Error(`unknown object kind byte: ${prefix}`);
  const body = encoding.slice(1);
  if (kind === "blob") return { kind: "blob", data: body };
  return JSON.parse(new TextDecoder().decode(body)) as StoredObject;
}

export async function hashEncoding(encoding: Uint8Array): Promise<ObjectId> {
  const digest = await crypto.subtle.digest(SHA256_ALGO, encoding as BufferSource);
  return objectId(toHex(digest));
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function makeTree(entries: TreeEntry[]): Tree {
  return { kind: "tree", entries: sortTreeEntries(entries) };
}
