# @javelin/agents

Agent integrations for Javelin. Coding agents commit work through `@javelin/vcs`
repositories with machine-readable provenance attached, so a human supervisor
can see who produced every commit, with which model, from which prompt.

## Generic capture

`captureAgentRun(repo, spec, files)` — the core primitive. It:

1. stages `files` (a `Record<path, string | Uint8Array>`) into the index,
2. commits with a structured message (`agent(<adapter>): <prompt summary>` plus
   `Javelin-Agent:` / `Javelin-Model:` / `Javelin-Session:` / `Javelin-Parent-Run:` trailers),
3. records a `ProvenanceRecord` via `@javelin/provenance` (which amends the
   commit and fast-forwards the branch ref),
4. returns `{ commitId, provenanceId, record }` where `commitId` is the amended
   commit that carries the provenance id in its `provenance` list.

`commitWithProvenance(repo, { adapter, session, model, prompt, message, files? })`
is the CLI-facing wrapper (the CLI itself lives in a sibling package).

## Adapters

Both adapters read real session logs with tolerant JSONL parsing: corrupt lines
are skipped, unknown shapes ignored, and a missing directory returns `[]`
without throwing.

### Codex (`readCodexSessions(dir)`, default `~/.codex/sessions`)

Parses `rollout-*.jsonl` files:

| line type        | fields used                                             |
| ---------------- | ------------------------------------------------------- |
| `session_meta`   | `payload.session_id`, `payload.cwd`, `payload.timestamp` |
| `response_item`  | first non-instruction user message becomes `prompt`      |
| `turn_context`   | `payload.model`                                          |
| `event_msg`      | `task_complete` timestamp becomes `finishedAt`           |

`codexToSpec(summary)` maps a session to an `AgentRunSpec`
(`agent: "codex"`, `adapter: "codex"`, `exit: "success"` when a completion was seen).

### Claude Code (`readClaudeSessions(dir)`, default `~/.claude/projects`)

Parses `<session-id>.jsonl` files:

| line type    | fields used                                            |
| ------------ | ------------------------------------------------------ |
| `user`       | `message.content` (string or text blocks) as `prompt`, `timestamp`, `cwd`; sidechain lines skipped |
| `assistant`  | `message.model` (synthetic placeholders ignored), `timestamp` as `finishedAt` |

`claudeToSpec(summary)` maps a session to an `AgentRunSpec`
(`agent: "claude-code"`, `adapter: "claude-code"`).

## Run composition

`runChain(repo, [{ spec, files }, ...])` captures runs sequentially and links
each to the previous run's `provenanceId` via `parentRun`. A chain across
agents (e.g. Codex plans, Claude implements, Codex tests) resolves into a
parent graph through `resolveRunGraph` from `@javelin/provenance`.

## Example

```ts
import { openRepository } from "@javelin/vcs";
import { resolveRunGraph } from "@javelin/provenance";
import { captureAgentRun, runChain, readCodexSessions, codexToSpec } from "@javelin/agents";

const repo = await openRepository("/path/to/repo");

// manual capture
await captureAgentRun(
  repo,
  { agent: "zai-bot", model: "glm-4.7", prompt: "Fix the login bug", session: "sess-123" },
  { "src/auth.ts": "export const fixed = true;\n" },
);

// capture from real Codex session logs
for (const s of await readCodexSessions()) {
  console.log(s.session, s.model, s.prompt);
}

// a supervised chain across two agents
await runChain(repo, [
  { spec: { agent: "codex", adapter: "codex", prompt: "Plan the API", session: "c1" }, files: { "docs/api-plan.md": "# plan" } },
  { spec: { agent: "claude-code", adapter: "claude-code", prompt: "Implement the API", session: "cc1" }, files: { "src/api.ts": "..." } },
]);

console.log(await resolveRunGraph(repo));
```

## Scope notes

- Per assumptions.md item 12, adapters degrade to the generic adapter when no
  local session logs exist; parsers are written against the observed Codex CLI
  (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) and Claude Code
  (`~/.claude/projects/**/*.jsonl`) formats and tolerate drift.
