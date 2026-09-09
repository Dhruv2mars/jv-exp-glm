import type { SearchResult } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";
import { keysetPage, type Page } from "./cursor";
import { cmp, countOccurrences } from "./text";

export interface ProvenanceSearchOptions {
  cursor?: string;
  limit?: number;
}

/**
 * Search provenance records (agent name, adapter, model, summary) by scanning
 * the object store. This package stays free of any derived provenance index;
 * records are read directly through the vcs API.
 */
export async function searchProvenance(
  repo: Repository,
  query: string,
  options: ProvenanceSearchOptions = {},
): Promise<Page<SearchResult>> {
  if (!query) return { hits: [] };
  type ProvenanceHit = Extract<SearchResult, { kind: "provenance" }>;
  const needle = query.toLowerCase();
  const hits: ProvenanceHit[] = [];
  for (const id of await repo.objects.list()) {
    const obj = await repo.objects.read(id);
    if (!obj || obj.kind !== "provenance") continue;
    const fields = [
      { text: obj.agent.name, weight: 4 },
      { text: obj.agent.adapter, weight: 3 },
      { text: obj.model ?? "", weight: 3 },
      { text: obj.summary ?? "", weight: 1 },
    ];
    let score = 0;
    for (const { text, weight } of fields) {
      const occurrences = countOccurrences(text.toLowerCase(), needle);
      if (occurrences > 0) score += Math.min(occurrences, 5) * weight;
    }
    if (score === 0) continue;
    hits.push({
      kind: "provenance",
      record: id,
      snippet: (obj.summary ?? `${obj.agent.name}${obj.model ? ` (${obj.model})` : ""}`).slice(0, 200),
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score || cmp(a.record, b.record));
  return keysetPage(hits, (h) => ({ s: h.score, k: h.record }), options.cursor, options.limit ?? 100);
}
