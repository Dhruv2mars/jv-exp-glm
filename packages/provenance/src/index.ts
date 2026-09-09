import type { ObjectId, ProvenanceRecord } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";

export interface ProvenanceEntry {
  id: ObjectId;
  record: ProvenanceRecord;
}

export type RunSpec = Omit<ProvenanceRecord, "kind">;

export interface RunFilter {
  agentName?: string;
  adapter?: ProvenanceRecord["agent"]["adapter"];
  exit?: NonNullable<ProvenanceRecord["exit"]>;
}

export interface RunGraph {
  nodes: ProvenanceEntry[];
  edges: { parent: ObjectId; child: ObjectId }[];
  roots: ObjectId[];
}

/** Writes a provenance record as a standalone append-only object (docs/adr/0005). */
export async function recordRun(repo: Repository, spec: RunSpec): Promise<ObjectId> {
  return repo.recordProvenance(spec);
}

/** All stored runs, ordered by startedAt then id for deterministic output. */
async function allRuns(repo: Repository): Promise<ProvenanceEntry[]> {
  const runs: ProvenanceEntry[] = [];
  for (const id of await repo.objects.list()) {
    const obj = await repo.objects.read(id);
    if (obj?.kind === "provenance") runs.push({ id, record: obj });
  }
  return runs.sort(
    (a, b) => a.record.startedAt.localeCompare(b.record.startedAt) || (a.id < b.id ? -1 : 1),
  );
}

/** Records referencing a state. Delegates to the v2 engine's reference scan. */
export async function provenanceFor(repo: Repository, stateId: ObjectId): Promise<ProvenanceEntry[]> {
  return repo.provenanceFor(stateId);
}

export async function queryRuns(repo: Repository, filter: RunFilter = {}): Promise<ProvenanceEntry[]> {
  const runs = await allRuns(repo);
  return runs.filter(
    (run) =>
      (filter.agentName === undefined || run.record.agent.name === filter.agentName) &&
      (filter.adapter === undefined || run.record.agent.adapter === filter.adapter) &&
      (filter.exit === undefined || run.record.exit === filter.exit),
  );
}

/**
 * Resolves parentRun references across all stored records into a DAG.
 * Edges point parent -> child; dangling parents (records not yet synced into
 * this repo) produce no edge. Roots are the records without a parentRun.
 */
export async function runGraph(repo: Repository): Promise<RunGraph> {
  const nodes = await allRuns(repo);
  const byId = new Map<string, ProvenanceEntry>(nodes.map((n) => [n.id as string, n]));
  const edges: RunGraph["edges"] = [];
  for (const node of nodes) {
    const parent = node.record.parentRun ? byId.get(node.record.parentRun) : undefined;
    if (parent) edges.push({ parent: parent.id, child: node.id });
  }
  const roots = nodes.filter((n) => !n.record.parentRun).map((n) => n.id);
  return { nodes, edges, roots };
}
