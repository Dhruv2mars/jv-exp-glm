import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Commit, EvidenceRecord, ObjectId } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";

export interface RepoPolicy {
  requireEvidence?: string[];
}

export interface PolicyViolation {
  check: string;
  detail: string;
}

export interface PolicyResult {
  ok: boolean;
  violations: PolicyViolation[];
}

export interface AttachEvidenceResult {
  evidenceId: ObjectId;
  /** Commit whose provenance list now contains evidenceId. Equal to commitId when already attached. */
  commitId: ObjectId;
  attached: boolean;
}

export class PolicyError extends Error {}

function metaPath(repoRoot: string): string {
  return join(repoRoot, ".javelin", "meta.json");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${crypto.randomUUID()}`);
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

async function readMeta(repoRoot: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(metaPath(repoRoot), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Persists the policy in the repo's javelind meta.json, preserving other fields. */
export async function setPolicy(repoRoot: string, policy: RepoPolicy | null): Promise<RepoPolicy> {
  const meta = await readMeta(repoRoot);
  if (!meta) throw new PolicyError(`no meta.json at ${metaPath(repoRoot)}; repository not initialized`);
  if (policy === null) {
    delete meta.policy;
  } else {
    meta.policy = policy;
  }
  await atomicWrite(metaPath(repoRoot), JSON.stringify(meta, null, 2) + "\n");
  return policy ?? {};
}

/** Reads the policy from the repo's javelind meta.json. */
export async function getPolicy(repoRoot: string): Promise<RepoPolicy | null> {
  const meta = await readMeta(repoRoot);
  const policy = meta?.policy;
  return policy && typeof policy === "object" ? (policy as RepoPolicy) : null;
}

/**
 * Walks commits from newHead and collects evidence records reachable through the
 * commits' provenance id lists. Every check in policy.requireEvidence must have at
 * least one 'pass' evidence record; a 'fail' record for a check also violates it.
 */
export async function evaluatePolicy(
  repo: Repository,
  newHead: ObjectId,
  policy: RepoPolicy | null | undefined,
): Promise<PolicyResult> {
  const required = policy?.requireEvidence ?? [];
  if (required.length === 0) return { ok: true, violations: [] };

  const passing = new Set<string>();
  const failing = new Set<string>();
  const seen = new Set<string>();
  const queue: ObjectId[] = [newHead];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    let commit: Commit;
    try {
      commit = await repo.loadCommit(id);
    } catch {
      continue;
    }
    for (const recordId of commit.provenance ?? []) {
      const obj = await repo.objects.read(recordId);
      if (!obj || obj.kind !== "evidence") continue;
      (obj.status === "pass" ? passing : failing).add(obj.check);
    }
    for (const parent of commit.parents) queue.push(parent);
  }

  const violations: PolicyViolation[] = [];
  for (const check of required) {
    if (passing.has(check)) continue;
    if (failing.has(check)) {
      violations.push({ check, detail: `evidence check '${check}' has failing status on ${newHead.slice(0, 12)}` });
    } else {
      violations.push({ check, detail: `no passing evidence for check '${check}' reachable from ${newHead.slice(0, 12)}` });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Writes an EvidenceRecord into the object store and attaches it to the commit the
 * same way @javelin/provenance records provenance: the record id is appended to the
 * commit's provenance list via an amended commit (same tree/parents/message) and the
 * ref pointing at the commit is fast-forwarded to the amendment via CAS. Reimplements
 * that mechanism locally so this package does not depend on @javelin/provenance.
 */
export async function attachEvidence(
  repo: Repository,
  commitId: ObjectId,
  record: EvidenceRecord,
): Promise<AttachEvidenceResult> {
  if (record.kind !== "evidence") throw new PolicyError("record.kind must be 'evidence'");
  const commit = await repo.loadCommit(commitId);
  const { id: evidenceId } = await repo.objects.write(record);
  if (commit.provenance?.includes(evidenceId)) {
    return { evidenceId, commitId, attached: false };
  }
  const amended: Commit = {
    ...commit,
    provenance: [...(commit.provenance ?? []), evidenceId],
  };
  const { id: amendedId } = await repo.objects.write(amended);
  const refs = await repo.refs.list();
  const refName = Object.keys(refs).find((name) => refs[name] === commitId);
  if (!refName) {
    throw new PolicyError(`no ref points at commit ${commitId}; cannot attach evidence`);
  }
  const result = await repo.refs.set(refName, amendedId, commitId);
  if (!result.ok) throw new PolicyError(`evidence attach failed on ${refName}: ${result.detail}`);
  return { evidenceId, commitId: amendedId, attached: true };
}
