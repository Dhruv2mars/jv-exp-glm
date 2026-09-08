import type { SearchHit } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";

/** Search commit messages by substring or regex; higher score means stronger match. */
export async function searchHistory(repo: Repository, query: string, limit = 20): Promise<SearchHit[]> {
  if (!query) return [];
  let matcher: (message: string) => number;
  try {
    const re = new RegExp(query, "gi");
    matcher = (message) => countMatches(message, re);
  } catch {
    const needle = query.toLowerCase();
    matcher = (message) => countOccurrences(message.toLowerCase(), needle);
  }
  const log = await repo.log(await repo.currentBranch(), 1000);
  const hits: SearchHit[] = [];
  for (const { id, commit } of log) {
    const occurrences = matcher(commit.message);
    if (occurrences === 0) continue;
    const exact = commit.message.toLowerCase() === query.toLowerCase();
    const firstLine = commit.message.split("\n", 1)[0] ?? commit.message;
    hits.push({
      kind: "history",
      commit: id,
      snippet: firstLine.slice(0, 200),
      score: Math.min(occurrences, 10) + (exact ? 10 : 0) + (commit.message.toLowerCase().startsWith(query.toLowerCase()) ? 2 : 0),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
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
