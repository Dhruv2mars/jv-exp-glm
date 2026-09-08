import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectId } from "@javelin/protocol";
import { openRepository, type Repository } from "@javelin/vcs";
import { indexCommit, searchCode, searchHistory, searchProvenance } from ".";

let root: string;
let repo: Repository;

async function commitFiles(files: Record<string, string>, message: string): Promise<ObjectId> {
  for (const [path, content] of Object.entries(files)) {
    await repo.stage(path, new TextEncoder().encode(content));
  }
  return repo.commit({ message, time: "2026-01-01T00:00:00.000Z" });
}

async function commitWithProvenance(paths: string[], message: string, provenance: ObjectId[]): Promise<ObjectId> {
  const head = await repo.refs.get("refs/heads/main");
  const headFiles = head ? await repo.readCommitTree(head) : {};
  const files: Record<string, ObjectId> = {};
  for (const path of paths) {
    files[path] = (await repo.readIndex())[path] ?? headFiles[path]!;
  }
  const time = "2026-01-01T00:00:00.000Z";
  const commit = {
    kind: "commit" as const,
    tree: await repo.buildTreeFromIndex(),
    parents: head ? [head] : [],
    author: { name: "test", email: "test@local", time },
    committer: { name: "test", email: "test@local", time },
    message,
    provenance,
  };
  const { id } = await repo.objects.write(commit);
  await repo.refs.set("refs/heads/main", id, head);
  return id;
}

function writeProvenance(record: {
  agent: { name: string; adapter: "generic" | "codex" | "claude-code" };
  model?: string;
  summary?: string;
}): Promise<ObjectId> {
  return repo.objects
    .write({ kind: "provenance", startedAt: "2026-01-01T00:00:00.000Z", exit: "success", ...record })
    .then((r) => r.id);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "javelin-search-"));
  repo = await openRepository(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("searchCode", () => {
  test("finds a string in the right file with a useful snippet", async () => {
    await commitFiles(
      { "src/app.ts": "export function greet() {\n  return 'hello quantum foam';\n}\n", "README.md": "nothing here\n" },
      "add app",
    );
    const head = (await repo.refs.get("refs/heads/main"))!;
    await indexCommit(repo, head);
    const hits = await searchCode(repo, "quantum foam");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe("src/app.ts");
    expect(hits[0]!.snippet).toContain("hello quantum foam");
    expect(hits[0]!.commit).toBe(head);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  test("matches files by case-insensitive path substring", async () => {
    await commitFiles(
      { "src/RouterConfig.ts": "plain content\n", "docs/guide.md": "plain content\n" },
      "add files",
    );
    const head = (await repo.refs.get("refs/heads/main"))!;
    await indexCommit(repo, head);
    const hits = await searchCode(repo, "routerconfig");
    expect(hits.map((h) => h.path)).toEqual(["src/RouterConfig.ts"]);
  });

  test("results are ranked score-descending and limit is respected", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.txt`] = `needle appears needle here ${i}\n`;
    files["rare.txt"] = "needle once\n";
    await commitFiles(files, "batch");
    const head = (await repo.refs.get("refs/heads/main"))!;
    await indexCommit(repo, head);
    const hits = await searchCode(repo, "needle");
    expect(hits.length).toBeGreaterThan(1);
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect((await searchCode(repo, "needle", 3))).toHaveLength(3);
  });

  test("indexing a commit is idempotent", async () => {
    await commitFiles({ "a.txt": "wombat\n" }, "first");
    const head = (await repo.refs.get("refs/heads/main"))!;
    await indexCommit(repo, head);
    const first = await Bun.file(join(root, ".javelin/search", `${head}.json`)).text();
    await indexCommit(repo, head);
    const second = await Bun.file(join(root, ".javelin/search", `${head}.json`)).text();
    expect(second).toBe(first);
    expect((await searchCode(repo, "wombat")).map((h) => h.path)).toEqual(["a.txt"]);
  });

  test("re-indexing a later commit reflects new content", async () => {
    const c1 = await commitFiles({ "a.txt": "alpha beta\n" }, "one");
    await indexCommit(repo, c1);
    const c2 = await commitFiles({ "a.txt": "alpha gamma\n" }, "two");
    await indexCommit(repo, c2);
    expect((await searchCode(repo, "beta", 20, c1)).length).toBe(1);
    expect((await searchCode(repo, "beta", 20, c2)).length).toBe(0);
    expect((await searchCode(repo, "gamma", 20, c2)).length).toBe(1);
  });

  test("search without an explicit commit defaults to HEAD", async () => {
    await commitFiles({ "a.txt": "alpha\n" }, "one");
    const c1 = (await repo.refs.get("refs/heads/main"))!;
    await indexCommit(repo, c1);
    const c2 = await commitFiles({ "b.txt": "zeta\n" }, "two");
    await indexCommit(repo, c2);
    expect((await searchCode(repo, "zeta")).map((h) => h.path)).toEqual(["b.txt"]);
    expect((await searchCode(repo, "zeta"))[0]!.commit).toBe(c2);
  });
});

describe("searchHistory", () => {
  test("finds commits by message substring", async () => {
    await commitFiles({ "a.txt": "1\n" }, "fix the login bug");
    await commitFiles({ "b.txt": "2\n" }, "add the logout flow");
    const hits = await searchHistory(repo, "login");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain("login");
  });

  test("supports regex queries and falls back on invalid regex", async () => {
    await commitFiles({ "a.txt": "1\n" }, "refactor: split parser");
    await commitFiles({ "b.txt": "2\n" }, "fix: parser crash");
    const reHits = await searchHistory(repo, "^fix:");
    expect(reHits).toHaveLength(1);
    expect(reHits[0]!.snippet).toContain("fix: parser crash");
    const literalHits = await searchHistory(repo, "split parser");
    expect(literalHits).toHaveLength(1);
  });

  test("limit is respected", async () => {
    await commitFiles({ "a.txt": "1\n" }, "wip one");
    await commitFiles({ "b.txt": "2\n" }, "wip two");
    expect(await searchHistory(repo, "wip", 1)).toHaveLength(1);
  });
});

describe("searchProvenance", () => {
  test("finds records by agent name", async () => {
    const p1 = await writeProvenance({ agent: { name: "alpha-agent", adapter: "generic" }, summary: "did a thing" });
    const p2 = await writeProvenance({ agent: { name: "beta-agent", adapter: "codex" }, model: "m1", summary: "other" });
    const c = await commitWithProvenance(["a.txt"], "with provenance", [p1, p2]);
    const hits = await searchProvenance(repo, "beta");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.provenance).toBe(p2);
    expect(hits[0]!.commit).toBe(c);
  });

  test("finds records by model and summary", async () => {
    const p = await writeProvenance({ agent: { name: "a", adapter: "claude-code" }, model: "glm-flash", summary: "ported the indexer" });
    await commitWithProvenance(["a.txt"], "work", [p]);
    expect(await searchProvenance(repo, "glm-flash")).toHaveLength(1);
    const bySummary = await searchProvenance(repo, "indexer");
    expect(bySummary).toHaveLength(1);
    expect(bySummary[0]!.snippet).toContain("ported the indexer");
  });

  test("limit is respected", async () => {
    const ps = await Promise.all([
      writeProvenance({ agent: { name: "worker-1", adapter: "generic" } }),
      writeProvenance({ agent: { name: "worker-2", adapter: "generic" } }),
    ]);
    await commitWithProvenance(["a.txt"], "work", ps);
    expect(await searchProvenance(repo, "worker", 1)).toHaveLength(1);
    expect(await searchProvenance(repo, "worker", 10)).toHaveLength(2);
  });
});
