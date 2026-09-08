import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeToSpec, codexToSpec, readClaudeSessions, readCodexSessions } from "./adapters";

let home: string;
let codexDir: string;
let claudeDir: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "javelin-adapters-"));
  codexDir = join(home, ".codex", "sessions", "2026", "09", "01");
  claudeDir = join(home, ".claude", "projects", "-tmp-proj");
  await mkdir(codexDir, { recursive: true });
  await mkdir(claudeDir, { recursive: true });

  await writeFile(
    join(codexDir, "rollout-2026-09-01T10-00-00-abc.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-09-01T10:00:00.000Z",
        type: "session_meta",
        payload: { session_id: "codex-sess-1", timestamp: "2026-09-01T10:00:00.000Z", cwd: "/tmp/proj", cli_version: "0.118.0" },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:00:01.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the flaky test in src/x.test.ts" }] },
      }),
      JSON.stringify({ timestamp: "2026-09-01T10:00:02.000Z", type: "turn_context", payload: { model: "gpt-5-codex", cwd: "/tmp/proj" } }),
      JSON.stringify({ timestamp: "2026-09-01T10:05:00.000Z", type: "event_msg", payload: { type: "task_complete" } }),
      "not json at all",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(claudeDir, "claude-sess-9.jsonl"),
    [
      JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-09-01T11:00:00.000Z", sessionId: "claude-sess-9", content: "hi" }),
      JSON.stringify({ type: "user", timestamp: "2026-09-01T11:00:01.000Z", cwd: "/tmp/proj", message: { role: "user", content: "Add a README section" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-09-01T11:00:30.000Z", message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "done" }] } }),
      "{corrupt",
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("codex adapter", () => {
  test("parses synthetic session logs", async () => {
    const sessions = await readCodexSessions(join(home, ".codex", "sessions"));
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.session).toBe("codex-sess-1");
    expect(s.prompt).toBe("Fix the flaky test in src/x.test.ts");
    expect(s.model).toBe("gpt-5-codex");
    expect(s.cwd).toBe("/tmp/proj");
    expect(s.finishedAt).toBe("2026-09-01T10:05:00.000Z");

    const spec = codexToSpec(s);
    expect(spec.agent).toBe("codex");
    expect(spec.adapter).toBe("codex");
    expect(spec.session).toBe("codex-sess-1");
    expect(spec.exit).toBe("success");
  });

  test("missing dir returns empty without throwing", async () => {
    const sessions = await readCodexSessions(join(home, "does-not-exist"));
    expect(sessions).toEqual([]);
  });
});

describe("claude adapter", () => {
  test("parses synthetic session logs", async () => {
    const sessions = await readClaudeSessions(join(home, ".claude", "projects"));
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.session).toBe("claude-sess-9");
    expect(s.prompt).toBe("Add a README section");
    expect(s.model).toBe("claude-sonnet-4-5");
    expect(s.startedAt).toBe("2026-09-01T11:00:01.000Z");

    const spec = claudeToSpec(s);
    expect(spec.agent).toBe("claude-code");
    expect(spec.adapter).toBe("claude-code");
  });

  test("missing dir returns empty without throwing", async () => {
    const sessions = await readClaudeSessions(join(home, "nope"));
    expect(sessions).toEqual([]);
  });
});
