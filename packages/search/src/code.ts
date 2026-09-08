import { mkdir, readFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectId, SearchHit } from "@javelin/protocol";
import { isObjectId } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";

const SEARCH_DIR = "search";

interface CommitIndex {
  commit: ObjectId;
  files: Record<string, ObjectId>;
  /** Lowercased trigram -> file paths containing it. */
  trigrams: Record<string, string[]>;
}

function searchDir(root: string): string {
  return join(root, ".javelin", SEARCH_DIR);
}

function indexPath(root: string, commitId: ObjectId): string {
  return join(searchDir(root), `${commitId}.json`);
}

export function trigrams(text: string): string[] {
  const t = text.toLowerCase();
  if (t.length < 3) return t.length > 0 ? [t] : [];
  const out = new Set<string>();
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return [...out];
}

async function readCommitIndex(root: string, commitId: ObjectId): Promise<CommitIndex | null> {
  try {
    const raw = JSON.parse(await readFile(indexPath(root, commitId), "utf8")) as CommitIndex;
    if (raw.commit !== commitId || !raw.files || !raw.trigrams) return null;
    for (const id of Object.values(raw.files)) if (!isObjectId(id)) return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeCommitIndex(root: string, index: CommitIndex): Promise<void> {
  const dir = searchDir(root);
  await mkdir(dir, { recursive: true });
  const path = indexPath(root, index.commit);
  const tmp = join(dir, `.tmp-${crypto.randomUUID()}`);
  await Bun.write(tmp, JSON.stringify(index) + "\n");
  await rename(tmp, path);
}

/**
 * Build (or rebuild) the code search index for one commit, persisted at
 * `.javelin/search/<commitId>.json`. Deterministic and idempotent: indexing the
 * same commit twice produces byte-identical output.
 */
export async function indexCommit(repo: Repository, commitId: ObjectId): Promise<void> {
  const files = await repo.readCommitTree(commitId);
  const trigrams: Record<string, Set<string>> = {};
  for (const [path, id] of Object.entries(files)) {
    let content = "";
    try {
      content = new TextDecoder().decode(await repo.readBlob(id)).toLowerCase();
    } catch {
      content = "";
    }
    for (const t of trigramSet(path.toLowerCase(), content)) {
      (trigrams[t] ??= new Set()).add(path);
    }
  }
  const index: CommitIndex = {
    commit: commitId,
    files,
    trigrams: Object.fromEntries([...Object.entries(trigrams)].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, ps]) => [t, [...ps].sort()])),
  };
  await writeCommitIndex(repo.root, index);
}

function trigramSet(path: string, content: string): string[] {
  const out = new Set<string>();
  for (const t of trigrams(path)) out.add(t);
  for (let i = 0; i + 3 <= content.length; i++) out.add(content.slice(i, i + 3));
  return [...out];
}

async function latestIndexedCommit(root: string): Promise<ObjectId | null> {
  const dir = searchDir(root);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const ids = names.filter((n) => isObjectId(n.replace(/\.json$/, ""))).sort();
  const last = ids.at(-1);
  return last ? last.replace(/\.json$/, "") as ObjectId : null;
}

/**
 * Ranked substring search over an indexed commit (defaults to HEAD, falling
 * back to the most recently indexed commit). Candidates come from the trigram
 * index, then each blob is verified against the real content, so a stale index
 * cannot produce false positives. Short queries (<3 chars) scan every file.
 */
export async function searchCode(repo: Repository, query: string, limit = 20, commitId?: ObjectId): Promise<SearchHit[]> {
  if (!query) return [];
  const id = commitId ?? (await defaultCommit(repo));
  if (!id) return [];
  const index = await readCommitIndex(repo.root, id);
  if (!index) return [];
  const needle = query.toLowerCase();
  const candidates = new Set<string>(
    needle.length < 3 ? Object.keys(index.files) : trigrams(needle).flatMap((t) => index.trigrams[t] ?? []),
  );
  const hits: SearchHit[] = [];
  for (const path of [...candidates].sort()) {
    const blobId = index.files[path];
    if (!blobId) continue;
    let content = "";
    try {
      content = new TextDecoder().decode(await repo.readBlob(blobId));
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    const at = lower.indexOf(needle);
    const inPath = path.toLowerCase().includes(needle);
    if (at < 0 && !inPath) continue;
    const lineStart = content.lastIndexOf("\n", at) + 1;
    const lineEnd = content.indexOf("\n", at + needle.length);
    const snippet = at >= 0 ? content.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).slice(0, 200) : "";
    const occurrences = countOccurrences(lower, needle);
    const score = occurrences * 2 + (inPath ? 5 : 0) + (at === 0 ? 1 : 0);
    hits.push({ kind: "code", path, commit: id, snippet: snippet || undefined, score });
  }
  return hits.sort((a, b) => b.score - a.score || cmp(a.path, b.path)).slice(0, limit);
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

async function defaultCommit(repo: Repository): Promise<ObjectId | null> {
  try {
    return await repo.resolveToCommit(await repo.currentBranch());
  } catch {
    return latestIndexedCommit(repo.root);
  }
}

function cmp(a: string | undefined, b: string | undefined): number {
  return (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;
}

export { SEARCH_DIR };
