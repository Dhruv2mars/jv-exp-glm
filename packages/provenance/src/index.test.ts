import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectId, ProvenanceRecord, State } from "@javelin/protocol";
import { init, type Repository } from "@javelin/vcs";
import { provenanceFor, queryRuns, recordRun, runGraph } from "./index";

let root: string;
let repo: Repository;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jvl-prov-"));
  repo = await init(root);
  await repo.layerNew("work");
  await repo.layerSwitch("work");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Checkpoint a real file change on the "work" layer and return the state id. */
async function checkpointFile(path: string, content: string, message: string): Promise<ObjectId> {
  const abs = join(root, path);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
  const { stateId } = await repo.checkpoint({ message });
  return stateId;
}

function run(overrides: Partial<Omit<ProvenanceRecord, "kind">> = {}): Omit<ProvenanceRecord, "kind"> {
  return {
    states: [],
    agent: { name: "builder", adapter: "claude-code" },
    startedAt: "2026-09-09T00:00:00Z",
    exit: "success",
    ...overrides,
  };
}

describe("provenance v2", () => {
  test("recordRun writes a standalone object; provenanceFor finds it by state", async () => {
    const stateId = await checkpointFile("a.txt", "one", "first");
    const record = run({ states: [stateId], summary: "wrote a.txt" });
    const provenanceId = await recordRun(repo, record);

    const hits = await provenanceFor(repo, stateId);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(provenanceId);
    expect(hits[0]!.record).toEqual({ kind: "provenance", ...record });
  });

  test("recording never mutates states: ids, state content, and heads are unchanged", async () => {
    const stateId = await checkpointFile("a.txt", "one", "first");
    const before: State = await repo.loadState(stateId);
    const headBefore = (await repo.layerGet("work"))!.head;
    const worldBefore = await repo.worldHead();

    await recordRun(repo, run({ states: [stateId] }));
    await recordRun(repo, run({ states: [stateId], agent: { name: "fixer", adapter: "codex" } }));

    expect(await repo.loadState(stateId)).toEqual(before);
    expect((await repo.layerGet("work"))!.head).toBe(headBefore);
    expect(await repo.worldHead()).toBe(worldBefore);
  });

  test("queryRuns filters stored records by agent, adapter, and exit", async () => {
    const s1 = await checkpointFile("a.txt", "one", "first");
    await recordRun(repo, run({ states: [s1], summary: "run-a" }));
    const s2 = await checkpointFile("b.txt", "two", "second");
    await recordRun(repo, run({
      states: [s2],
      agent: { name: "fixer", adapter: "codex" },
      startedAt: "2026-09-09T01:00:00Z",
      exit: "failure",
      summary: "run-b",
    }));
    const s3 = await checkpointFile("c.txt", "three", "third");
    await recordRun(repo, run({
      states: [s3],
      agent: { name: "fixer", adapter: "generic" },
      startedAt: "2026-09-09T02:00:00Z",
      summary: "run-c",
    }));

    expect((await queryRuns(repo, { agentName: "fixer" })).map((r) => r.record.summary)).toEqual(["run-b", "run-c"]);
    expect((await queryRuns(repo, { adapter: "codex" })).map((r) => r.record.summary)).toEqual(["run-b"]);
    expect((await queryRuns(repo, { exit: "failure" })).map((r) => r.record.summary)).toEqual(["run-b"]);
    expect((await queryRuns(repo, { agentName: "fixer", adapter: "generic" })).map((r) => r.record.summary)).toEqual(["run-c"]);
    expect(await queryRuns(repo)).toHaveLength(3);
  });

  test("runGraph resolves parentRun chains into a DAG with roots", async () => {
    const s1 = await checkpointFile("a.txt", "one", "first");
    const r1 = await recordRun(repo, run({ states: [s1], startedAt: "2026-09-09T00:00:00Z", summary: "root" }));
    const s2 = await checkpointFile("b.txt", "two", "second");
    const r2 = await recordRun(repo, run({ states: [s2], parentRun: r1, startedAt: "2026-09-09T01:00:00Z", summary: "child" }));
    const s3 = await checkpointFile("c.txt", "three", "third");
    const r3 = await recordRun(repo, run({ states: [s3], parentRun: r2, startedAt: "2026-09-09T02:00:00Z", summary: "grandchild" }));
    const s4 = await checkpointFile("d.txt", "four", "fourth");
    const r4 = await recordRun(repo, run({ states: [s4], agent: { name: "other", adapter: "codex" }, startedAt: "2026-09-09T03:00:00Z" }));

    const graph = await runGraph(repo);
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toEqual([
      { parent: r1, child: r2 },
      { parent: r2, child: r3 },
    ]);
    expect(graph.roots.sort()).toEqual([r1, r4].sort());
    expect(graph.roots).not.toContain(r3);
  });

  test("a parentRun pointing at a missing record yields no edge, not a crash", async () => {
    const s1 = await checkpointFile("a.txt", "one", "first");
    await recordRun(repo, run({ states: [s1], parentRun: "f".repeat(64) }));
    const graph = await runGraph(repo);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
  });
});
