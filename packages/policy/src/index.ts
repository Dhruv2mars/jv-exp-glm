import type { EvidenceRecord, ObjectId } from "@javelin/protocol";
import type { Repository } from "@javelin/vcs";

export interface RequiredEvidence {
  check: string;
  /** When set, only evidence produced under this exact ruleset satisfies the check. */
  rules?: string;
}

export interface RepoPolicy {
  requireEvidence?: RequiredEvidence[];
  requiredContribution?: boolean;
}

export interface PolicyViolation {
  check: string;
  detail: string;
}

export interface PolicyResult {
  ok: boolean;
  violations: PolicyViolation[];
}

export interface CheckInput {
  state: ObjectId;
  rules: string;
  environment?: string;
  checks: EvidenceRecord["checks"];
}

const POLICY_KEY = "policy";
const CONTRIBUTION_CHECK = "required-contribution";

export class PolicyError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function short(id: ObjectId): string {
  return id.slice(0, 12);
}

/** Validates and normalizes a policy value. */
function parsePolicy(value: unknown): RepoPolicy {
  if (!isRecord(value)) throw new PolicyError("policy must be a JSON object");
  const unknown = Object.keys(value).filter((k) => k !== "requireEvidence" && k !== "requiredContribution");
  if (unknown.length > 0) throw new PolicyError(`unknown policy keys: ${unknown.join(", ")}`);
  const policy: RepoPolicy = {};
  if (value.requireEvidence !== undefined) {
    if (!Array.isArray(value.requireEvidence)) throw new PolicyError("requireEvidence must be an array");
    policy.requireEvidence = value.requireEvidence.map((entry) => {
      if (!isRecord(entry)) throw new PolicyError("requireEvidence entries must be objects");
      const extra = Object.keys(entry).filter((k) => k !== "check" && k !== "rules");
      if (extra.length > 0) throw new PolicyError(`unknown requireEvidence keys: ${extra.join(", ")}`);
      if (typeof entry.check !== "string" || entry.check.length === 0) {
        throw new PolicyError("requireEvidence check must be a non-empty string");
      }
      if (entry.rules !== undefined && (typeof entry.rules !== "string" || entry.rules.length === 0)) {
        throw new PolicyError("requireEvidence rules must be a non-empty string");
      }
      return entry.rules === undefined ? { check: entry.check } : { check: entry.check, rules: entry.rules };
    });
  }
  if (value.requiredContribution !== undefined) {
    if (typeof value.requiredContribution !== "boolean") {
      throw new PolicyError("requiredContribution must be a boolean");
    }
    policy.requiredContribution = value.requiredContribution;
  }
  return policy;
}

/** Reads the policy from repo meta. Absent means no requirements. A malformed stored policy throws. */
export async function getPolicy(repo: Repository): Promise<RepoPolicy | null> {
  const raw = await repo.meta.get(POLICY_KEY);
  if (raw === null) return null;
  try {
    return parsePolicy(JSON.parse(raw));
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    throw new PolicyError(`stored policy is not valid JSON: ${(e as Error).message}`);
  }
}

/** Writes the policy through a MetaStore CAS, or deletes it when policy is null. */
export async function setPolicy(repo: Repository, policy: RepoPolicy | null): Promise<void> {
  const validated = policy === null ? null : parsePolicy(policy);
  const expected = await repo.meta.get(POLICY_KEY);
  if (validated === null) {
    if (expected !== null && !(await repo.meta.delete(POLICY_KEY))) throw new PolicyError("policy moved during write; retry");
    return;
  }
  const moved = await repo.meta.compareAndSwap(POLICY_KEY, expected, JSON.stringify(validated));
  if (!moved.ok) throw new PolicyError("policy moved during write; retry");
}

/**
 * Records an EvidenceRecord bound to the exact state, rules, and environment.
 * Thin wrapper over Repository.recordEvidence for policy producers.
 */
export async function recordCheck(repo: Repository, input: CheckInput): Promise<ObjectId> {
  const { state, rules, environment, checks } = input;
  return repo.recordEvidence({
    state,
    rules,
    environment,
    checks,
    at: new Date().toISOString(),
  });
}

function evidenceDetail(req: RequiredEvidence, stateId: ObjectId, evidence: { record: EvidenceRecord }[]): string {
  const named = evidence.filter(({ record }) => record.checks.some((c) => c.check === req.check));
  if (named.length === 0) return `no evidence for check '${req.check}' on ${short(stateId)}`;
  const inScope = named.filter(({ record }) => req.rules === undefined || record.rules === req.rules);
  if (inScope.some(({ record }) => record.checks.some((c) => c.check === req.check && c.status === "fail"))) {
    return `evidence for check '${req.check}' on ${short(stateId)} has status 'fail'`;
  }
  const rules = [...new Set(named.map(({ record }) => record.rules))];
  return `evidence for check '${req.check}' on ${short(stateId)} was produced under rules '${rules.join("', '")}' but policy requires '${req.rules}'`;
}

/**
 * Evaluates the publish boundary for a contribution (docs/javelin-model.md: Publish is
 * not CI). Reads the repo policy and checks only records referencing the proposed
 * state — never a history walk. Absent policy means publish needs VCS correctness only.
 */
export async function evaluatePublish(repo: Repository, contributionId: ObjectId): Promise<PolicyResult> {
  const [policy, found] = await Promise.all([getPolicy(repo), repo.contribution(contributionId)]);
  if (!found) throw new PolicyError(`no such contribution: ${contributionId}`);
  const { contribution, meta } = found;
  const violations: PolicyViolation[] = [];
  if (policy?.requiredContribution) {
    if (meta.status !== "open") {
      violations.push({ check: CONTRIBUTION_CHECK, detail: `contribution status is '${meta.status}', policy requires 'open'` });
    }
    const ref = await repo.layerGet(contribution.layer);
    if (!ref || ref.head !== contribution.state) {
      const head = ref?.head ? short(ref.head) : "null";
      violations.push({
        check: CONTRIBUTION_CHECK,
        detail: `layer '${contribution.layer}' head ${head} is not the proposed state ${short(contribution.state)}`,
      });
    }
  }
  const required = policy?.requireEvidence ?? [];
  const evidence = required.length > 0 ? await repo.evidenceFor(contribution.state) : [];
  for (const req of required) {
    const satisfied = evidence.some(({ record }) =>
      record.checks.some(
        (c) => c.check === req.check && c.status === "pass" && (req.rules === undefined || record.rules === req.rules),
      ),
    );
    if (satisfied) continue;
    violations.push({ check: req.check, detail: evidenceDetail(req, contribution.state, evidence) });
  }
  return { ok: violations.length === 0, violations };
}
