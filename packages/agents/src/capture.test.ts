import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectId } from "../../protocol/src/model";
import { init, type Repository } from "@javelin/vcs";
import { provenanceFor, queryRuns, runGraph } from "@javelin/provenance";
import { captureAgentRun, runChain, structuredMessage, type FileChanges } from "./capture";

let root: string;
let repo: Repository;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "javelin-agents-"));
  repo = await init(root);
  await repo.layerNew("agents");
  await repo.layerSwitch("agents");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function blobFor(stateId: ObjectId, path: string): Promise<Uint8Array> {
  const parts = path.split("/");
  let tree = await repo.loadTree((await repo.loadState(stateId)).tree);
  for (const part of parts.slice(0, -1)) {
    const dir = tree.entries.find((e) => e.name === part && e.kind === "tree");
    if (!dir) throw new Error(`missing directory ${part} in ${path}`);
    tree = await repo.loadTree(dir.id);
  }
  const leaf = tree.entries.find((e) => e.name === parts[parts.length - 1]);
  if (!leaf) throw new Error(`missing file ${path}`);
  return repo.readBlob(leaf.id);
}

describe("captureAgentRun", () => {
  test("checkpoints the layer and references that exact state id", async () => {
    const run = await captureAgentRun(
      repo,
      {
        agent: "zai-bot",
        model: "glm-4.7",
        prompt: "Fix the login bug",
        session: "sess-123",
        adapter: "claude-code",
        exit: "success",
      },
      { "src/auth.ts": "export const fixed = true;\n" },
    );

    const layer = (await repo.layerGet("agents"))!;
    expect(layer.head).toBe(run.stateId);
    const log = await repo.layerLog("agents");
    expect(log.map((e) => e.id)).toContain(run.stateId);
    expect(log[0]!.state.message).toContain("agent(claude-code): Fix the login bug");
    expect(log[0]!.state.message).toContain("Javelin-Agent: zai-bot");
    expect(log[0]!.state.message).toContain("Javelin-Model: glm-4.7");
    expect(log[0]!.state.message).toContain("Javelin-Session: sess-123");
    expect(new TextDecoder().decode(await blobFor(run.stateId, "src/auth.ts"))).toBe("export const fixed = true;\n");

    const hits = await provenanceFor(repo, run.stateId);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(run.provenanceId);
    expect(hits[0]!.record.states).toEqual([run.stateId]);
    expect(hits[0]!.record.agent).toEqual({ name: "zai-bot", adapter: "claude-code", session: "sess-123" });
    expect(hits[0]!.record.model).toBe("glm-4.7");
    expect(hits[0]!.record.prompt).toBe("Fix the login bug");
    expect(hits[0]!.record.exit).toBe("success");
    expect(run.record.kind).toBe("provenance");
  });

  test("recording provenance leaves the state and its id unchanged", async () => {
    const run = await captureAgentRun(repo, { agent: "a", prompt: "first" }, { "a.txt": "one" });
    const stateBefore = await repo.loadState(run.stateId);
    const headBefore = (await repo.layerGet("agents"))!.head;

    await captureAgentRun(repo, { agent: "a", prompt: "second" }, { "b.txt": "two" });

    expect(await repo.loadState(run.stateId)).toEqual(stateBefore);
    expect((await repo.layerGet("agents"))!.head).not.toBe(headBefore);
    const log = await repo.layerLog("agents");
    expect(log.map((e) => e.id)).toContain(run.stateId);
    expect(log.map((e) => e.state.message).some((m) => m.includes("agent(generic): first"))).toBe(true);
  });

  test("rejects file paths outside the repository", async () => {
    const err = await captureAgentRun(repo, { agent: "a" }, { "../escape.txt": "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("escapes the repository");
  });
});

describe("runChain", () => {
  test("three runs across two agents resolve into a parent graph", async () => {
    const runs = await runChain(repo, [
      {
        spec: { agent: "codex", adapter: "codex", model: "gpt-5-codex", prompt: "Plan the API", session: "c1", startedAt: "2026-09-09T00:00:00Z", exit: "success" },
        files: { "docs/api-plan.md": "# plan\n" },
      },
      {
        spec: { agent: "claude-code", adapter: "claude-code", model: "claude-sonnet-4-5", prompt: "Implement the API", session: "cc1", startedAt: "2026-09-09T00:01:00Z", exit: "success" },
        files: { "src/api.ts": "export const api = {};\n" },
      },
      {
        spec: { agent: "codex", adapter: "codex", model: "gpt-5-codex", prompt: "Test the API", session: "c2", startedAt: "2026-09-09T00:02:00Z", exit: "success" },
        files: { "src/api.test.ts": "test('api', () => {});\n" },
      },
    ]);
    expect(runs).toHaveLength(3);
    expect(runs[1]!.record.parentRun).toBe(runs[0]!.provenanceId);
    expect(runs[2]!.record.parentRun).toBe(runs[1]!.provenanceId);

    expect((await repo.layerGet("agents"))!.head).toBe(runs[2]!.stateId);
    const log = await repo.layerLog("agents");
    const messages = log.map((e) => e.state.message);
    expect(messages.some((m) => m.includes("Plan the API"))).toBe(true);
    expect(messages.some((m) => m.includes("Implement the API"))).toBe(true);
    expect(messages.some((m) => m.includes("Test the API"))).toBe(true);
    expect(new TextDecoder().decode(await blobFor(runs[2]!.stateId, "docs/api-plan.md"))).toBe("# plan\n");
    expect(new TextDecoder().decode(await blobFor(runs[2]!.stateId, "src/api.ts"))).toBe("export const api = {};\n");
    expect(new TextDecoder().decode(await blobFor(runs[2]!.stateId, "src/api.test.ts"))).toBe("test('api', () => {});\n");

    const graph = await runGraph(repo);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual([
      { parent: runs[0]!.provenanceId, child: runs[1]!.provenanceId },
      { parent: runs[1]!.provenanceId, child: runs[2]!.provenanceId },
    ]);
    expect(graph.roots).toEqual([runs[0]!.provenanceId]);
    expect(graph.roots).not.toContain(runs[2]!.provenanceId);

    expect((await queryRuns(repo, { adapter: "codex" })).length).toBe(2);
    expect((await queryRuns(repo, { agentName: "claude-code" })).length).toBe(1);
    expect((await queryRuns(repo, { exit: "success" })).length).toBe(3);
    expect((await queryRuns(repo, { exit: "failure" })).length).toBe(0);
  });

  test("structuredMessage truncates long prompts", () => {
    const msg = structuredMessage({ agent: "x", prompt: "a".repeat(200) });
    expect(msg.length).toBeLessThan(120);
    expect(msg.endsWith("\u2026")).toBe(false);
    expect(msg.split("\n")[0]!.length).toBeLessThan(100);
  });
});
