import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvenanceRecord } from "@javelin/protocol";
import { getProvenance, queryRuns, resolveRunGraph } from "@javelin/provenance";
import { openRepository, type Repository } from "@javelin/vcs";
import { captureAgentRun, commitWithProvenance, runChain, structuredMessage } from "./capture";

let root: string;
let repo: Repository;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "javelin-agents-"));
  repo = await openRepository(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("captureAgentRun", () => {
  test("commits files and attaches provenance with correct fields", async () => {
    const run = await captureAgentRun(
      repo,
      {
        agent: "zai-bot",
        model: "glm-4.7",
        prompt: "Fix the login bug",
        session: "sess-123",
        exit: "success",
      },
      { "src/auth.ts": "export const fixed = true;\n" },
    );

    const commit = await repo.loadCommit(run.commitId);
    expect(commit.message).toContain("agent(generic): Fix the login bug");
    expect(commit.message).toContain("Javelin-Agent: zai-bot");
    expect(commit.message).toContain("Javelin-Model: glm-4.7");
    expect(commit.message).toContain("Javelin-Session: sess-123");

    const blobId = (await repo.readCommitTree(run.commitId))["src/auth.ts"];
    expect(blobId).toBeDefined();
    const blob = await repo.readBlob(blobId!);
    expect(new TextDecoder().decode(blob)).toBe("export const fixed = true;\n");

    const records = await getProvenance(repo, run.commitId);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.agent).toEqual({ name: "zai-bot", adapter: "generic", session: "sess-123" });
    expect(rec.model).toBe("glm-4.7");
    expect(rec.prompt).toBe("Fix the login bug");
    expect(rec.exit).toBe("success");
    expect(rec.startedAt).toBeTruthy();
    expect(run.record.kind).toBe("provenance");
  });

  test("commitWithProvenance honours adapter and custom message", async () => {
    const run = await commitWithProvenance(repo, {
      adapter: "codex",
      agent: "codex",
      session: "abc",
      prompt: "Refactor utils",
      message: "fix: refactor utils",
      files: { "src/util.ts": "export const util = 1;\n" },
    });
    const commit = await repo.loadCommit(run.commitId);
    expect(commit.message).toBe("fix: refactor utils");
    const records = await getProvenance(repo, run.commitId);
    expect((records[0] as ProvenanceRecord).agent.adapter).toBe("codex");
  });
});

describe("runChain", () => {
  test("links three runs across two agents and resolves the parent graph", async () => {
    const runs = await runChain(repo, [
      { spec: { agent: "codex", adapter: "codex", model: "gpt-5-codex", prompt: "Plan the API", session: "c1" }, files: { "docs/api-plan.md": "# plan\n" } },
      { spec: { agent: "claude-code", adapter: "claude-code", model: "claude-sonnet-4-5", prompt: "Implement the API", session: "cc1" }, files: { "src/api.ts": "export const api = {};\n" } },
      { spec: { agent: "codex", adapter: "codex", model: "gpt-5-codex", prompt: "Test the API", session: "c2" }, files: { "src/api.test.ts": "test('api', () => {});\n" } },
    ]);
    expect(runs).toHaveLength(3);
    expect(runs[1]!.record.parentRun).toBe(runs[0]!.provenanceId);
    expect(runs[2]!.record.parentRun).toBe(runs[1]!.provenanceId);

    // linear commit history
    const log = await repo.log(runs[2]!.commitId);
    expect(log.length).toBeGreaterThanOrEqual(5);
    const messages = log.map((e) => e.commit.message);
    expect(messages.some((m) => m.includes("Plan the API"))).toBe(true);
    expect(messages.some((m) => m.includes("Implement the API"))).toBe(true);

    // tree contents from each run present at the chain head
    const files = await repo.readCommitTree(log[0]!.id);
    expect(files["docs/api-plan.md"]).toBeDefined();
    expect(files["src/api.ts"]).toBeDefined();
    expect(files["src/api.test.ts"]).toBeDefined();

    const graph = await resolveRunGraph(repo);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(3);
    expect(graph.edges.some((e) => e.parent === runs[0]!.provenanceId && e.child === runs[1]!.provenanceId)).toBe(true);
    expect(graph.edges.some((e) => e.parent === runs[1]!.provenanceId && e.child === runs[2]!.provenanceId)).toBe(true);
    // chain tail is a root (no run links to it); the chain head has a parent
    expect(graph.roots).toContain(runs[0]!.provenanceId);
    expect(graph.roots).not.toContain(runs[2]!.provenanceId);

    const codexRuns = await queryRuns(repo, { adapter: "codex" });
    expect(codexRuns.length).toBeGreaterThanOrEqual(2);
  });

  test("structuredMessage truncates long prompts", () => {
    const msg = structuredMessage({ agent: "x", prompt: "a".repeat(200) });
    expect(msg.length).toBeLessThan(120);
    expect(msg.endsWith("\u2026")).toBe(false);
    expect(msg.split("\n")[0]!.length).toBeLessThan(100);
  });
});
