import type { SearchResult } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";
import { keysetPage, type Page } from "./cursor";
import { cmp, countOccurrences } from "./text";

export interface HistorySearchOptions {
  cursor?: string;
  limit?: number;
}

/**
 * Search state messages across the object store by substring or regex; higher
 * score means stronger match.
 */
export async function searchHistory(
  repo: Repository,
  query: string,
  options: HistorySearchOptions = {},
): Promise<Page<SearchResult>> {
  if (!query) return { hits: [] };
  type HistoryHit = Extract<SearchResult, { kind: "history" }>;
  let matcher: (message: string) => number;
  try {
    const re = new RegExp(query, "gi");
    matcher = (message) => [...message.matchAll(re)].length;
  } catch {
    const needle = query.toLowerCase();
    matcher = (message) => countOccurrences(message.toLowerCase(), needle);
  }
  const hits: HistoryHit[] = [];
  for (const id of await repo.objects.list()) {
    const obj = await repo.objects.read(id);
    if (!obj || obj.kind !== "state") continue;
    const occurrences = matcher(obj.message);
    if (occurrences === 0) continue;
    const exact = obj.message.toLowerCase() === query.toLowerCase();
    hits.push({
      kind: "history",
      state: id,
      snippet: (obj.message.split("\n", 1)[0] ?? obj.message).slice(0, 200),
      score:
        Math.min(occurrences, 10) +
        (exact ? 10 : 0) +
        (obj.message.toLowerCase().startsWith(query.toLowerCase()) ? 2 : 0),
    });
  }
  hits.sort((a, b) => b.score - a.score || cmp(a.state, b.state));
  return keysetPage(hits, (h) => ({ s: h.score, k: h.state }), options.cursor, options.limit ?? 100);
}
