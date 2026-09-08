import type { Commit, ObjectId, ProvenanceRecord } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";

export interface ProvenanceEntry {
  id: ObjectId;
  commitId: ObjectId;
  record: ProvenanceRecord;
}

export interface RunFilter {
  agentName?: string;
  adapter?: ProvenanceRecord["agent"]["adapter"];
  exit?: NonNullable<ProvenanceRecord["exit"]>;
  since?: string;
}

export interface RunGraph {
  nodes: ProvenanceEntry[];
  edges: { parent: ObjectId; child: ObjectId }[];
  roots: ObjectId[];
}

export interface RecordProvenanceResult {
  provenanceId: ObjectId;
  /** Commit whose provenance list now contains provenanceId. Equal to commitId when already attached. */
  commitId: ObjectId;
  attached: boolean;
}

function matches(record: ProvenanceRecord, filter: RunFilter): boolean {
  if (filter.agentName !== undefined && record.agent.name !== filter.agentName) return false;
  if (filter.adapter !== undefined && record.agent.adapter !== filter.adapter) return false;
  if (filter.exit !== undefined && record.exit !== filter.exit) return false;
  if (filter.since !== undefined && record.startedAt < filter.since) return false;
  return true;
}

/**
 * Writes the record into the object store and attaches its id to the commit by
 * creating an amended commit (same tree/parents/message, provenance extended).
 * The branch pointing at commitId is fast-forwarded to the amendment via CAS.
 */
export async function recordProvenance(
  repo: Repository,
  commitId: ObjectId,
  record: ProvenanceRecord,
): Promise<RecordProvenanceResult> {
  const commit = await repo.loadCommit(commitId);
  const { id: provenanceId } = await repo.objects.write(record);
  if (commit.provenance?.includes(provenanceId)) {
    return { provenanceId, commitId, attached: false };
  }
  const amended: Commit = {
    ...commit,
    provenance: [...(commit.provenance ?? []), provenanceId],
  };
  const { id: amendedId } = await repo.objects.write(amended);
  const refs = await repo.refs.list();
  const refName = Object.keys(refs).find((name) => refs[name] === commitId);
  if (!refName) {
    throw new Error(`no ref points at commit ${commitId}; cannot attach provenance`);
  }
  const result = await repo.refs.set(refName, amendedId, commitId);
  if (!result.ok) throw new Error(`provenance attach failed on ${refName}: ${result.detail}`);
  return { provenanceId, commitId: amendedId, attached: true };
}

export async function getProvenance(repo: Repository, commitId: ObjectId): Promise<ProvenanceRecord[]> {
  const commit = await repo.loadCommit(commitId);
  const records: ProvenanceRecord[] = [];
  for (const id of commit.provenance ?? []) {
    const obj = await repo.objects.read(id);
    if (!obj || obj.kind !== "provenance") throw new Error(`not a provenance record: ${id}`);
    records.push(obj);
  }
  return records;
}

export async function queryRuns(repo: Repository, filter: RunFilter = {}): Promise<ProvenanceEntry[]> {
  const entries: ProvenanceEntry[] = [];
  const seenCommits = new Set<string>();
  const seenRecords = new Set<string>();
  const refs = await repo.refs.list();
  for (const ref of Object.keys(refs).sort()) {
    const log = await repo.log(ref, Number.MAX_SAFE_INTEGER);
    for (const { id, commit } of log) {
      if (seenCommits.has(id)) continue;
      seenCommits.add(id);
      for (const provId of commit.provenance ?? []) {
        if (seenRecords.has(provId)) continue;
        seenRecords.add(provId);
        const obj = await repo.objects.read(provId);
        if (!obj || obj.kind !== "provenance") continue;
        if (!matches(obj, filter)) continue;
        entries.push({ id: provId, commitId: id, record: obj });
      }
    }
  }
  return entries;
}

export async function resolveRunGraph(repo: Repository): Promise<RunGraph> {
  const nodes = await queryRuns(repo);
  const byId = new Map(nodes.map((n) => [n.id as string, n]));
  const edges: RunGraph["edges"] = [];
  const hasParent = new Set<string>();
  for (const node of nodes) {
    const parentRun = node.record.parentRun;
    if (!parentRun) continue;
    if (!byId.has(parentRun)) continue;
    edges.push({ parent: byId.get(parentRun)!.id, child: node.id });
    hasParent.add(node.id);
  }
  const childIds = new Set(edges.map((e) => e.child as string));
  const roots = nodes.filter((n) => !childIds.has(n.id as string)).map((n) => n.id);
  return { nodes, edges, roots };
}
