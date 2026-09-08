import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openRepository } from "./index";
import { Repository } from "./repo";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jvl-repo-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function commitFile(repo: Repository, path: string, content: string, message: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
  await repo.stage(path, enc(content));
  return repo.commit({ message });
}

describe("repository basics", () => {
  test("openRepository creates .javelin layout", async () => {
    const repo = await openRepository(root);
    expect(repo.refs.dir).toContain(join(".javelin", "refs"));
    expect(repo.objects.dir).toContain(join(".javelin", "objects"));
  });

  test("commit, log, checkout", async () => {
    const repo = await openRepository(root);
    const c1 = await commitFile(repo, "a.txt", "one", "first");
    const c2 = await commitFile(repo, "dir/b.txt", "two", "second");
    expect(c2).not.toBe(c1);
    const log = await repo.log("refs/heads/main");
    expect(log.map((e) => e.commit.message)).toEqual(["second", "first"]);
    expect(log[0]!.commit.parents).toEqual([c1]);

    await writeFile(join(root, "a.txt"), "mutated");
    await repo.checkout(c1);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one");
    await repo.checkout("main");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one");
    expect(await readFile(join(root, "dir/b.txt"), "utf8")).toBe("two");
  });

  test("readTree returns flat path map", async () => {
    const repo = await openRepository(root);
    await commitFile(repo, "src/x.ts", "x", "add x");
    await commitFile(repo, "src/sub/y.ts", "y", "add y");
    const head = await repo.resolveToCommit("main");
    const commit = await repo.loadCommit(head);
    const files = await repo.readTree("src", commit.tree);
    expect(Object.keys(files).sort()).toEqual(["src/sub/y.ts", "src/x.ts"]);
  });

  test("diff between commits", async () => {
    const repo = await openRepository(root);
    await commitFile(repo, "a.txt", "v1", "one");
    await commitFile(repo, "a.txt", "v2", "two");
    await commitFile(repo, "new.txt", "n", "three");
    const log = await repo.log("main", 3);
    const oldBlob = (await repo.readCommitTree(log[2]!.id))["a.txt"]!;
    const entries = await repo.diff(log[2]!.id, log[0]!.id);
    expect(entries).toEqual([
      { path: "a.txt", status: "modified", oldId: oldBlob, newId: expect.any(String) },
      { path: "new.txt", status: "added", oldId: null, newId: expect.any(String) },
    ]);
  });

  test("branches create/list/delete", async () => {
    const repo = await openRepository(root);
    await commitFile(repo, "a.txt", "1", "first");
    const create = await repo.createBranch("feature");
    expect(create.ok).toBe(true);
    const branches = await repo.listBranches().then((bs) => bs.map((b) => b.name).sort());
    expect(branches).toEqual(["feature", "main"]);
    await repo.setHeadBranch("feature");
    const del = await repo.deleteBranch("feature");
    expect(del.ok).toBe(false);
    await repo.setHeadBranch("main");
    expect((await repo.deleteBranch("feature")).ok).toBe(true);
  });

  test("ref CAS rejects stale update", async () => {
    const repo = await openRepository(root);
    const c1 = await commitFile(repo, "a.txt", "1", "first");
    const c2 = await commitFile(repo, "a.txt", "2", "second");
    const result = await repo.refs.set("refs/heads/main", c1, c1);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cas-mismatch");
  });
});

describe("merge", () => {
  test("clean three-way merge commits with two parents", async () => {
    const repo = await openRepository(root);
    await commitFile(repo, "base.txt", "base", "base");
    await repo.createBranch("side");
    await commitFile(repo, "ours.txt", "ours", "ours change");
    await repo.setHeadBranch("side");
    await repo.checkout("side");
    await commitFile(repo, "theirs.txt", "theirs", "their change");
    await repo.setHeadBranch("main");
    await repo.checkout("main");

    const result = await repo.mergeBranch("side");
    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
    const head = await repo.loadCommit(await repo.resolveToCommit("main"));
    expect(head.parents).toHaveLength(2);
    expect(dec(await repo.readBlob((await repo.readCommitTree(head.parents[1]!))["theirs.txt"]!))).toBe("theirs");
    expect(await readFile(join(root, "ours.txt"), "utf8")).toBe("ours");
    expect((await repo.log("main")).length).toBe(4);
  });

  test("conflicting edit reports structured conflict and leaves main untouched", async () => {
    const repo = await openRepository(root);
    await commitFile(repo, "f.txt", "base", "base");
    await repo.createBranch("side");
    await commitFile(repo, "f.txt", "ours", "ours edit");
    await repo.setHeadBranch("side");
    await repo.checkout("side");
    await commitFile(repo, "f.txt", "theirs", "their edit");
    await repo.setHeadBranch("main");
    await repo.checkout("main");

    const result = await repo.mergeBranch("side");
    expect(result.ok).toBe(false);
    expect(result.commitId).toBeNull();
    expect(result.conflicts).toEqual([
      { path: "f.txt", baseId: expect.any(String), oursId: expect.any(String), theirsId: expect.any(String) },
    ]);
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("ours");
    const head = await repo.loadCommit(await repo.resolveToCommit("main"));
    expect(head.parents).toHaveLength(1);
  });

  test("non-overlapping edits to same directory merge cleanly", async () => {
    const repo = await openRepository(root);
    await commitFile(repo, "pkg/a", "a", "base");
    await repo.createBranch("side");
    await commitFile(repo, "pkg/b", "b", "ours");
    await repo.setHeadBranch("side");
    await repo.checkout("side");
    await commitFile(repo, "pkg/c", "c", "theirs");
    await repo.setHeadBranch("main");
    await repo.checkout("main");
    const result = await repo.mergeBranch("side");
    expect(result.ok).toBe(true);
    const files = Object.keys(await repo.readCommitTree(await repo.resolveToCommit("main"))).sort();
    expect(files).toEqual(["pkg/a", "pkg/b", "pkg/c"]);
  });
});

describe("fsck", () => {
  test("passes on real history", async () => {
    const repo = await openRepository(root);
    await commitFile(repo, "a.txt", "1", "first");
    await repo.createBranch("side");
    await commitFile(repo, "b.txt", "2", "second");
    await repo.setHeadBranch("side");
    await commitFile(repo, "c.txt", "3", "third");
    await repo.setHeadBranch("main");
    await repo.mergeBranch("side");
    const result = await repo.fsck();
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.objects).toBeGreaterThan(5);
  });

  test("detects corrupt object content", async () => {
    const repo = await openRepository(root);
    await commitFile(repo, "a.txt", "1", "first");
    const treeId = (await repo.loadCommit(await repo.resolveToCommit("main"))).tree;
    await writeFile(join(repo.objects.dir, treeId.slice(0, 2), treeId.slice(2)), "\x02not-json");
    const result = await repo.fsck();
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.id === treeId)).toBe(true);
  });
});
