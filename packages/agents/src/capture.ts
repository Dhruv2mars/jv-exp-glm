import type { ObjectId, ProvenanceRecord } from "@javelin/protocol";
import { recordProvenance } from "@javelin/provenance";
import type { Repository } from "@javelin/vcs";

/** A file change an agent produced, keyed by repo-relative path. */
export type FileChanges = Record<string, string | Uint8Array>;

export interface AgentRunSpec {
  agent: string;
  model?: string;
  prompt?: string;
  session?: string;
  adapter?: ProvenanceRecord["agent"]["adapter"];
  parentRun?: string;
  startedAt?: string;
  finishedAt?: string;
  exit?: ProvenanceRecord["exit"];
  summary?: string;
  /** Commit message; defaults to a structured agent message. */
  message?: string;
  author?: { name: string; email: string };
}

export interface CapturedRun {
  commitId: ObjectId;
  provenanceId: ObjectId;
  record: ProvenanceRecord;
}

export function summarizePrompt(prompt: string | undefined, max = 72): string {
  const line = (prompt ?? "").replace(/\s+/g, " ").trim();
  if (!line) return "agent run";
  return line.length > max ? line.slice(0, max - 1) + "\u2026" : line;
}

export function structuredMessage(spec: AgentRunSpec): string {
  const adapter = spec.adapter ?? "generic";
  const lines = [`agent(${adapter}): ${summarizePrompt(spec.prompt)}`, ""];
  lines.push(`Javelin-Agent: ${spec.agent}`);
  if (spec.model) lines.push(`Javelin-Model: ${spec.model}`);
  if (spec.session) lines.push(`Javelin-Session: ${spec.session}`);
  if (spec.parentRun) lines.push(`Javelin-Parent-Run: ${spec.parentRun}`);
  return lines.join("\n");
}

export function toRecord(spec: AgentRunSpec): ProvenanceRecord {
  return {
    kind: "provenance",
    agent: {
      name: spec.agent,
      adapter: spec.adapter ?? "generic",
      ...(spec.session ? { session: spec.session } : {}),
    },
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.prompt ? { prompt: spec.prompt } : {}),
    ...(spec.parentRun ? { parentRun: spec.parentRun } : {}),
    startedAt: spec.startedAt ?? new Date().toISOString(),
    ...(spec.finishedAt ? { finishedAt: spec.finishedAt } : {}),
    ...(spec.exit ? { exit: spec.exit } : {}),
    ...(spec.summary ? { summary: spec.summary } : {}),
  };
}

/**
 * Captures an agent run: stages `files` onto the working tree/index, commits
 * with a structured message, then records provenance (which amends the commit
 * and fast-forwards the branch). Returns the amended commit id and the
 * provenance record id.
 */
export async function captureAgentRun(
  repo: Repository,
  spec: AgentRunSpec,
  files: FileChanges = {},
): Promise<CapturedRun> {
  for (const [path, data] of Object.entries(files)) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await repo.stage(path, bytes);
  }
  const commitId = await repo.commit({
    message: spec.message ?? structuredMessage(spec),
    ...(spec.author ? { author: spec.author, committer: spec.author } : {}),
  });
  const record = toRecord(spec);
  const { provenanceId, commitId: amendedId } = await recordProvenance(repo, commitId, record);
  return { commitId: amendedId, provenanceId, record };
}

export interface CommitWithProvenanceOptions extends AgentRunSpec {
  adapter: ProvenanceRecord["agent"]["adapter"];
  /** Extra file changes to include in the commit. */
  files?: FileChanges;
}

/**
 * CLI-facing helper: commit `files` (or whatever is already staged) and attach
 * provenance describing the agent session that produced it.
 */
export async function commitWithProvenance(
  repo: Repository,
  opts: CommitWithProvenanceOptions,
): Promise<CapturedRun> {
  return captureAgentRun(repo, opts, opts.files ?? {});
}

/**
 * Chains agent runs: each spec after the first is linked to the previous run's
 * provenance id via `parentRun`, producing a resolvable run graph across agents.
 */
export async function runChain(
  repo: Repository,
  runs: { spec: AgentRunSpec; files?: FileChanges }[],
): Promise<CapturedRun[]> {
  const captured: CapturedRun[] = [];
  for (const { spec, files } of runs) {
    const parentRun = captured.length > 0 ? captured[captured.length - 1]!.provenanceId : spec.parentRun;
    const run = await captureAgentRun(repo, { ...spec, parentRun }, files ?? {});
    captured.push(run);
  }
  return captured;
}
