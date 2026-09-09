import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ObjectId, ProvenanceRecord } from "@javelin/protocol";
import { recordRun } from "@javelin/provenance";
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
  /** Checkpoint message; defaults to a structured agent message. */
  message?: string;
  author?: { name: string; email: string };
}

export interface CapturedRun {
  stateId: ObjectId;
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

export function toRecord(spec: AgentRunSpec): Omit<ProvenanceRecord, "kind" | "states"> {
  return {
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

async function applyFileChanges(repo: Repository, files: FileChanges): Promise<void> {
  const root = resolve(repo.root);
  for (const [path, data] of Object.entries(files)) {
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(root + "/")) {
      throw new Error(`file path escapes the repository working dir: ${path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }
}

/**
 * Captures an agent run on the checked-out layer: applies `files` to the
 * working dir, checkpoints the layer, then records a provenance object
 * referencing the checkpoint state (docs/adr/0005). States are never mutated.
 */
export async function captureAgentRun(
  repo: Repository,
  spec: AgentRunSpec,
  files: FileChanges = {},
): Promise<CapturedRun> {
  await applyFileChanges(repo, files);
  const { stateId } = await repo.checkpoint({
    message: spec.message ?? structuredMessage(spec),
    ...(spec.author ? { author: spec.author } : {}),
  });
  const record: ProvenanceRecord = { kind: "provenance", ...toRecord(spec), states: [stateId] };
  const provenanceId = await recordRun(repo, record);
  return { stateId, provenanceId, record };
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
    captured.push(await captureAgentRun(repo, { ...spec, parentRun }, files ?? {}));
  }
  return captured;
}
