import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectId, SearchResult } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";
import { keysetPage, type Page } from "./cursor";
import { cmp } from "./text";

const SEARCH_DIR = "search";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

type CodeHit = Extract<SearchResult, { kind: "code" }>;

export interface StateIndex {
  state: ObjectId;
  files: Record<string, ObjectId>;
  /** Lowercased trigram -> paths whose path or content contains it. */
  trigrams: Record<string, string[]>;
}

export interface CodeSearchOptions {
  /** State whose tree is searched; defaults to the world head. */
  stateId?: ObjectId;
  cursor?: string;
  limit?: number;
}

function searchDir(root: string): string {
  return join(root, ".javelin", SEARCH_DIR);
}

function indexPath(root: string, stateId: ObjectId): string {
  return join(searchDir(root), `${stateId}.json`);
}

export function trigrams(text: string): string[] {
  const t = text.toLowerCase();
  if (t.length < 3) return t.length > 0 ? [t] : [];
  const out = new Set<string>();
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return [...out];
}

function contentTrigrams(content: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= content.length; i++) out.add(content.slice(i, i + 3));
  return [...out];
}

async function readStateIndex(root: string, stateId: ObjectId): Promise<StateIndex | null> {
  try {
    const raw = JSON.parse(await readFile(indexPath(root, stateId), "utf8")) as StateIndex;
    if (raw.state !== stateId || !raw.files || !raw.trigrams) return null;
    for (const id of Object.values(raw.files)) if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeStateIndex(root: string, index: StateIndex): Promise<void> {
  const dir = searchDir(root);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${crypto.randomUUID()}`);
  await Bun.write(tmp, JSON.stringify(index) + "\n");
  await rename(tmp, indexPath(root, index.state));
}

async function flattenTree(repo: Repository, treeId: ObjectId): Promise<Record<string, ObjectId>> {
  const files: Record<string, ObjectId> = {};
  const walk = async (id: ObjectId, dir: string): Promise<void> => {
    for (const entry of (await repo.loadTree(id)).entries) {
      const full = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === "tree") await walk(entry.id, full);
      else files[full] = entry.id;
    }
  };
  await walk(treeId, "");
  return files;
}

export async function hasIndex(repo: Repository, stateId: ObjectId): Promise<boolean> {
  return (await readStateIndex(repo.root, stateId)) !== null;
}

/**
 * Build the code search index for one state's tree, persisted at
 * `.javelin/search/<stateId>.json`. Deterministic and idempotent: indexing the
 * same state twice produces identical output.
 */
export async function indexCommit(repo: Repository, stateId: ObjectId): Promise<void> {
  const state = await repo.loadState(stateId);
  const files = await flattenTree(repo, state.tree);
  const trigramMap: Record<string, Set<string>> = {};
  for (const [path, id] of Object.entries(files)) {
    let content = "";
    try {
      content = decoder.decode(await repo.readBlob(id)).toLowerCase();
    } catch {
      content = "";
    }
    for (const t of trigrams(path.toLowerCase())) (trigramMap[t] ??= new Set()).add(path);
    for (const t of contentTrigrams(content)) (trigramMap[t] ??= new Set()).add(path);
  }
  const index: StateIndex = {
    state: stateId,
    files,
    trigrams: Object.fromEntries(
      Object.entries(trigramMap)
        .sort(([a], [b]) => cmp(a, b))
        .map(([t, paths]) => [t, [...paths].sort()]),
    ),
  };
  await writeStateIndex(repo.root, index);
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  const last = haystack.length - needle.length;
  for (let i = from; i <= last; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function countOccurrencesBytes(haystack: Uint8Array, needle: Uint8Array): number {
  let count = 0;
  let at = indexOfBytes(haystack, needle);
  while (at >= 0) {
    count++;
    at = indexOfBytes(haystack, needle, at + needle.length);
  }
  return count;
}

function lineSnippet(bytes: Uint8Array, at: number, end: number): string {
  let start = at;
  while (start > 0 && bytes[start - 1] !== 0x0a) start--;
  let stop = end;
  while (stop < bytes.length && bytes[stop] !== 0x0a) stop++;
  return decoder.decode(bytes.slice(start, stop)).slice(0, 200);
}

/**
 * Substring search over one state's tree (defaults to the world head, indexing
 * it first when missing). Candidates come from the trigram index, then each
 * blob is verified byte-exactly against the real content, so a stale index
 * cannot produce false positives and binary files search safely. Short queries
 * (<3 chars) scan every file. Content matching is byte-exact; paths match
 * case-insensitively.
 */
export async function searchCode(
  repo: Repository,
  query: string,
  options: CodeSearchOptions = {},
): Promise<Page<SearchResult>> {
  if (!query) return { hits: [] };
  const stateId = options.stateId ?? (await repo.worldHead());
  if (!stateId) return { hits: [] };
  let index = await readStateIndex(repo.root, stateId);
  if (!index) {
    await indexCommit(repo, stateId);
    index = await readStateIndex(repo.root, stateId);
  }
  if (!index) return { hits: [] };
  const needleLower = query.toLowerCase();
  const needleBytes = encoder.encode(query);
  const candidates =
    needleLower.length < 3
      ? Object.keys(index.files).sort()
      : [...new Set(trigrams(needleLower).flatMap((t) => index.trigrams[t] ?? []))].sort();
  const hits: CodeHit[] = [];
  for (const path of candidates) {
    const blobId = index.files[path];
    if (!blobId) continue;
    let bytes: Uint8Array | null = null;
    try {
      bytes = await repo.readBlob(blobId);
    } catch {
      bytes = null;
    }
    const at = bytes ? indexOfBytes(bytes, needleBytes) : -1;
    const inPath = path.toLowerCase().includes(needleLower);
    if (at < 0 && !inPath) continue;
    const occurrences = bytes && at >= 0 ? countOccurrencesBytes(bytes, needleBytes) : 0;
    const score = occurrences * 2 + (inPath ? 5 : 0) + (at === 0 ? 1 : 0);
    const snippet = at >= 0 && bytes ? lineSnippet(bytes, at, at + needleBytes.length) : "";
    hits.push({ kind: "code", blob: blobId, path, snippet, score });
  }
  hits.sort((a, b) => b.score - a.score || cmp(a.path, b.path));
  return keysetPage(hits, (h) => ({ s: h.score, k: h.path }), options.cursor, options.limit ?? 100);
}
