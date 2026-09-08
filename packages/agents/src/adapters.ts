import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunSpec } from "./capture";

export interface SessionSummary {
  session: string;
  model?: string;
  prompt?: string;
  startedAt?: string;
  finishedAt?: string;
  cwd?: string;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

/** Parse JSONL tolerantly: skip blank/corrupt lines, cap each line's size. */
async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
    } catch {
      // tolerate corrupt lines
    }
  }
  return out;
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

// ---- Codex CLI (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ----

/**
 * Parses Codex CLI session logs. Schema observed in the wild:
 *   {type:"session_meta", payload:{session_id, timestamp, cwd, ...}}
 *   {type:"response_item", payload:{type:"message", role:"user", content:[{type:"input_text", text}]}}
 *   {type:"event_msg", payload:{type:"task_started"|"task_complete", ...}}
 * Parsing is tolerant: unknown shapes are skipped; a missing dir returns [].
 */
export async function readCodexSessions(sessionsDir: string): Promise<SessionSummary[]> {
  const summaries: SessionSummary[] = [];
  for (const file of await listJsonlFiles(sessionsDir)) {
    const lines = await readJsonl(file);
    let summary: SessionSummary | null = null;
    for (const line of lines) {
      const payload = line.payload as Record<string, unknown> | undefined;
      if (line.type === "session_meta" && payload) {
        const id = pickString(payload, ["session_id", "id"]) ?? fileBasename(file);
        if (!id) continue;
        summary = {
          session: id,
          ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
          ...(typeof payload.timestamp === "string" ? { startedAt: payload.timestamp } : {}),
        };
        if (typeof payload.model === "string") summary.model = payload.model;
      } else if (!summary && line.type === "response_item" && payload && payload.role === "user") {
        const text = textFromContent(payload.content);
        if (text && !text.startsWith("<")) {
          summary = { session: fileBasename(file) };
          summary.prompt = text;
        }
      } else if (summary && !summary.prompt && line.type === "response_item" && payload && payload.role === "user") {
        const text = textFromContent(payload.content);
        if (text && !text.startsWith("<")) summary.prompt = text;
      } else if (line.type === "turn_context" && payload && typeof payload.model === "string") {
        summary ??= { session: fileBasename(file) };
        summary.model = payload.model;
      } else if (line.type === "event_msg" && payload?.type === "task_complete" && typeof line.timestamp === "string") {
        summary ??= { session: fileBasename(file) };
        summary.finishedAt = line.timestamp;
      }
    }
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/** Map a parsed Codex session onto an AgentRunSpec for captureAgentRun. */
export function codexToSpec(s: SessionSummary): AgentRunSpec {
  return {
    agent: "codex",
    adapter: "codex",
    session: s.session,
    ...(s.model ? { model: s.model } : {}),
    ...(s.prompt ? { prompt: s.prompt } : {}),
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    ...(s.finishedAt ? { finishedAt: s.finishedAt, exit: "success" as const } : {}),
  };
}

// ---- Claude Code (~/.claude/projects/<project>/*.jsonl) ----

/**
 * Parses Claude Code session logs. Schema observed in the wild:
 *   {type:"user", message:{role:"user", content: string | [{type:"text",text}]}, timestamp, cwd}
 *   {type:"assistant", message:{model, role:"assistant", content:[...]}, timestamp}
 * Parsing is tolerant; a missing dir returns [].
 */
export async function readClaudeSessions(projectsDir: string): Promise<SessionSummary[]> {
  const summaries: SessionSummary[] = [];
  for (const file of await listJsonlFiles(projectsDir)) {
    const lines = await readJsonl(file);
    let summary: SessionSummary | null = null;
    for (const line of lines) {
      const message = line.message as Record<string, unknown> | undefined;
      if (line.type === "user" && message && !line.isSidechain) {
        const text = textFromContent(message.content);
        if (!text || text.startsWith("<")) continue;
        summary ??= { session: fileBasename(file).replace(/\.jsonl$/, "") };
        summary.prompt ??= text;
        if (!summary.startedAt && typeof line.timestamp === "string") summary.startedAt = line.timestamp;
        if (!summary.cwd && typeof line.cwd === "string") summary.cwd = line.cwd;
      } else if (line.type === "assistant" && message) {
        summary ??= { session: fileBasename(file).replace(/\.jsonl$/, "") };
        if (!summary.model && typeof message.model === "string" && !message.model.startsWith("<")) {
          summary.model = message.model;
        }
        if (typeof line.timestamp === "string") summary.finishedAt = line.timestamp;
      }
    }
    if (summary?.prompt || summary?.model) summaries.push(summary);
  }
  return summaries;
}

/** Map a parsed Claude Code session onto an AgentRunSpec for captureAgentRun. */
export function claudeToSpec(s: SessionSummary): AgentRunSpec {
  return {
    agent: "claude-code",
    adapter: "claude-code",
    session: s.session,
    ...(s.model ? { model: s.model } : {}),
    ...(s.prompt ? { prompt: s.prompt } : {}),
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    ...(s.finishedAt ? { finishedAt: s.finishedAt, exit: "success" as const } : {}),
  };
}

function fileBasename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export { listJsonlFiles, readJsonl };
