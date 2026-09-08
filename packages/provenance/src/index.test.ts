import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectId, type ObjectId, type ProvenanceRecord } from "@javelin/protocol";
import { openRepository, type Repository } from "@javelin/vcs";
import { getProvenance, queryRuns, recordProvenance, resolveRunGraph } from "./index";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jvl-prov-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function commitFile(repo: Repository, path: string, content: string, message: string): Promise<ObjectId> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
  await repo.stage(path, new TextEncoder().encode(content));
  return repo.commit({ message });
}

function run(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    kind: "provenance",
    agent: { name: "builder", adapter: "claude-code" },
    startedAt: "2026-09-09T00:00:00Z",
    exit: "success",
    ...overrides,
  };
}

describe("provenance", () => {
  test("record then get round-trips through the object store", async () => {
    const repo = await openRepository(root);
    const c1 = await commitFile(repo, "a.txt", "one", "first");
    const record = run({ summary: "wrote a.txt" });
    const { provenanceId, commitId } = await recordProvenance(repo, c1, record);
    expect(commitId).not.toBe(c1);

    const records = await getProvenance(repo, commitId);
    expect(records).toEqual([record]);
    const amended = await repo.loadCommit(commitId);
    expect(amended.provenance).toEqual([provenanceId]);
    expect(amended.message).toBe("first");
    expect(amended.tree).toBe((await repo.loadCommit(c1)).tree);
  });

  test("provenance ids are content-addressed and attachment is idempotent", async () => {
    const repo = await openRepository(root);
    const c1 = await commitFile(repo, "a.txt", "one", "first");
    const record = run();
    const first = await recordProvenance(repo, c1, record);
    const head = await repo.resolveToCommit("main");
    const second = await recordProvenance(repo, head, record);
    expect(first.provenanceId).toBe(second.provenanceId);
    expect(second.attached).toBe(false);
    expect(second.commitId).toBe(head);
    expect(await getProvenance(repo, head)).toHaveLength(1);
  });

  test("queryRuns filters by agent, adapter, exit, and since", async () => {
    const repo = await openRepository(root);
    const c1 = await commitFile(repo, "a.txt", "one", "first");
    await recordProvenance(repo, c1, run({ summary: "run-a" }));
    let head = await repo.resolveToCommit("main");
    const c2 = await commitFile(repo, "b.txt", "two", "second");
    await recordProvenance(repo, c2, run({
      agent: { name: "fixer", adapter: "codex" },
      startedAt: "2026-09-10T00:00:00Z",
      exit: "failure",
    }));
    head = await repo.resolveToCommit("main");
    const c3 = await commitFile(repo, "c.txt", "three", "third");
    await recordProvenance(repo, c3, run({
      agent: { name: "fixer", adapter: "generic" },
      startedAt: "2026-09-11T00:00:00Z",
      exit: "success",
    }));

    expect((await queryRuns(repo, { agentName: "fixer" })).length).toBe(2);
    expect((await queryRuns(repo, { adapter: "codex" })).length).toBe(1);
    expect((await queryRuns(repo, { exit: "failure" })).length).toBe(1);
    expect((await queryRuns(repo, { since: "2026-09-10T12:00:00Z" })).length).toBe(1);
    expect((await queryRuns(repo, { agentName: "fixer", adapter: "generic" })).length).toBe(1);
    expect((await queryRuns(repo)).length).toBe(3);
  });

  test("run graph resolves parentRun links across commits", async () => {
    const repo = await openRepository(root);
    const c1 = await commitFile(repo, "a.txt", "one", "first");
    const parent = await recordProvenance(repo, c1, run({ summary: "parent run" }));
    const c2 = await commitFile(repo, "b.txt", "two", "second");
    await recordProvenance(repo, c2, run({ parentRun: parent.provenanceId, summary: "child run" }));

    const graph = await resolveRunGraph(repo);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ parent: parent.provenanceId, child: graph.nodes.find((n) => n.record.parentRun)!.id }]);
    expect(graph.roots).toEqual([parent.provenanceId]);
  });

  test("provenance survives a merge commit", async () => {
    const repo = await openRepository(root);
    const rawBase = await commitFile(repo, "a.txt", "base", "base");
    const { commitId: base } = await recordProvenance(repo, rawBase, run({ summary: "base run" }));

    await repo.createBranch("side");
    const side = await commitFile(repo, "b.txt", "side", "side commit");
    await repo.checkout("main");
    await commitFile(repo, "c.txt", "main", "main commit");
    const merge = await repo.mergeBranch("side");
    expect(merge.ok).toBe(true);

    const mergeRun = await recordProvenance(repo, merge.commitId!, run({ summary: "merge run" }));
    const head = mergeRun.commitId;

    expect((await getProvenance(repo, base)).map((r) => r.summary)).toEqual(["base run"]);
    const logIds = (await repo.log("main")).map((e) => e.id);
    expect(logIds).toContain(base);
    expect((await getProvenance(repo, side)).length).toBe(0);
    const mergeRecords = await getProvenance(repo, head);
    expect(mergeRecords.map((r) => r.summary)).toEqual(["merge run"]);

    const graph = await resolveRunGraph(repo);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.roots.length).toBe(2);
    const mergeHeadCommit = await repo.loadCommit(head);
    expect(mergeHeadCommit.provenance?.length).toBe(1);
  });

  test("recordProvenance rejects commits no ref points at", async () => {
    const repo = await openRepository(root);
    const c1 = await commitFile(repo, "a.txt", "one", "first");
    const c2 = await commitFile(repo, "b.txt", "two", "second");
    const err = await recordProvenance(repo, c1, run()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(objectId(c2)).toBeDefined();
  });
});
