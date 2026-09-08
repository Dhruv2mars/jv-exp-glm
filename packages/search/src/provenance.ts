import type { ProvenanceRecord, SearchHit } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";

/**
 * Search provenance records (agent name, model, summary) reachable from
 * commits. Records are read directly from the object store via the vcs API;
 * this package does not depend on @javelin/provenance.
 */
export async function searchProvenance(repo: Repository, query: string, limit = 20): Promise<SearchHit[]> {
  if (!query) return [];
  const needle = query.toLowerCase();
  const log = await repo.log(await repo.currentBranch(), 1000);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const { id, commit } of log) {
    for (const provId of commit.provenance ?? []) {
      if (seen.has(provId)) continue;
      seen.add(provId);
      const obj = await repo.objects.read(provId);
      if (!obj || obj.kind !== "provenance") continue;
      const record = obj as ProvenanceRecord;
      const fields: { text: string; weight: number }[] = [
        { text: record.agent.name, weight: 4 },
        { text: record.model ?? "", weight: 3 },
        { text: record.summary ?? "", weight: 1 },
      ];
      let score = 0;
      for (const { text, weight } of fields) {
        const occurrences = countOccurrences(text.toLowerCase(), needle);
        if (occurrences > 0) score += Math.min(occurrences, 5) * weight;
      }
      if (score === 0) continue;
      hits.push({
        kind: "provenance",
        provenance: provId,
        commit: id,
        snippet: (record.summary ?? `${record.agent.name}${record.model ? ` (${record.model})` : ""}`).slice(0, 200),
        score,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
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
