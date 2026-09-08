import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importFromGit, exportToGit } from "./index";

const run = promisify(execFile);
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "jvl-bridge-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function sh(cwd: string, cmd: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd} failed: ${err}`);
  return out;
}

async function makeGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const env = 'GIT_AUTHOR_DATE="2026-01-01T00:00:00 +0000" GIT_COMMITTER_DATE="2026-01-01T00:00:00 +0000"';
  await sh(dir, `
    git init -q -b main .
    git config user.name "Alice Dev"
    git config user.email "alice@example.com"
    echo "hello v1" > a.txt
    mkdir sub && echo "nested content" > sub/b.txt
    echo "#!/bin/sh" > run.sh && chmod +x run.sh
    git add . && ${env} git commit -q -m "initial commit"
    git checkout -qb feature
    echo "feature line" >> a.txt
    git add . && ${env} git commit -q -m "feature work"
    git checkout -q main
    echo "main line" > c.txt
    git add . && ${env} git commit -q -m "main work"
    ${env} git merge -q --no-ff feature -m "merge feature into main"
    GIT_COMMITTER_DATE="2026-01-01T00:00:00 +0000" git tag -a v1.0 -m "release v1.0"
    git checkout -qb topic
    echo "topic" > t.txt
    git add . && ${env} git commit -q -m "topic commit"
    git checkout -q main
  `);
}

function flatOf(logOutput: string): string[] {
  return logOutput.trim().split("\n").filter(Boolean);
}

describe("importFromGit", () => {
  test("imports files, history shape, exec bit, branches and tags", async () => {
    const gitDir = join(base, "src-repo");
    const jvlDir = join(base, "jvl");
    await makeGitRepo(gitDir);

    const result = await importFromGit(gitDir, jvlDir);
    expect(result.warnings).toEqual([]);
    expect(result.commits).toBe(5);
    expect(Object.keys(result.refs).sort()).toEqual(["refs/heads/feature", "refs/heads/main", "refs/heads/topic", "refs/tags/v1.0"]);

    const { openRepository } = await import("@javelin/vcs");
    const repo = await openRepository(jvlDir);

    const headId = result.refs["refs/heads/main"]!;
    const commit = await repo.loadCommit(headId);
    expect(commit.message).toContain("merge feature into main");
    expect(commit.parents).toHaveLength(2);
    expect(commit.author).toEqual({ name: "Alice Dev", email: "alice@example.com", time: "2026-01-01T00:00:00.000Z" });

    const mergeParents = await Promise.all(commit.parents.map((p) => repo.loadCommit(p)));
    expect(mergeParents.map((c) => c.message).sort()).toEqual(["feature work\n", "main work\n"]);
    expect(mergeParents[0]!.parents).toHaveLength(1);

    const files = await repo.readCommitTree(headId);
    expect(Object.keys(files).sort()).toEqual(["a.txt", "c.txt", "run.sh", "sub/b.txt"]);
    expect(new TextDecoder().decode(await repo.readBlob(files["a.txt"]!))).toBe("hello v1\nfeature line\n");
    expect(new TextDecoder().decode(await repo.readBlob(files["sub/b.txt"]!))).toBe("nested content\n");

    const { loadExecSet } = await import("./import");
    const execSet = await loadExecSet(jvlDir);
    expect(execSet.has(files["run.sh"]!)).toBe(true);
    expect(execSet.has(files["a.txt"]!)).toBe(false);

    const featureFiles = await repo.readCommitTree(result.refs["refs/heads/feature"]!);
    expect(new TextDecoder().decode(await repo.readBlob(featureFiles["a.txt"]!))).toBe("hello v1\nfeature line\n");
    expect(featureFiles["c.txt"]).toBeUndefined();

    const tagId = result.refs["refs/tags/v1.0"]!;
    const tagObj = await repo.objects.read(tagId);
    expect(tagObj?.kind).toBe("tag");
    if (tagObj?.kind === "tag") expect(tagObj.name).toBe("v1.0");
  });

  test("is idempotent on re-import", async () => {
    const gitDir = join(base, "src-repo");
    const jvlDir = join(base, "jvl");
    await makeGitRepo(gitDir);

    const first = await importFromGit(gitDir, jvlDir);
    const { openRepository } = await import("@javelin/vcs");
    const repo = await openRepository(jvlDir);
    const afterFirst = Object.fromEntries(Object.entries(first.refs).sort());

    const second = await importFromGit(gitDir, jvlDir);
    expect(second.refs).toEqual(afterFirst);
    expect(second.commits).toBe(first.commits);
    expect(second.warnings).toEqual([]);
    expect(await repo.refs.list()).toEqual(afterFirst);
  });

  test("reports a warning for symlinks and skips them", async () => {
    const gitDir = join(base, "sym-repo");
    const jvlDir = join(base, "jvl-sym");
    await mkdir(gitDir, { recursive: true });
    await sh(gitDir, `
      git init -q -b main .
      git config user.name "S"
      git config user.email "s@x.com"
      echo real > target.txt
      ln -s target.txt link.txt
      git add -A && git commit -q -m "with symlink"
    `);
    const result = await importFromGit(gitDir, jvlDir);
    expect(result.warnings.some((w) => w.includes("link.txt"))).toBe(true);
  });
});

describe("exportToGit round-trip", () => {
  test("exported git repo matches original content, parents, messages", async () => {
    const gitDir = join(base, "src-repo");
    const jvlDir = join(base, "jvl");
    const outDir = join(base, "out-repo");
    await makeGitRepo(gitDir);
    await importFromGit(gitDir, jvlDir);
    const result = await exportToGit(jvlDir, outDir);
    expect(result.warnings).toEqual([]);
    expect(result.commits).toBe(5);

    const branches = flatOf(await sh(outDir, "git for-each-ref --format='%(refname)' refs/heads refs/tags")).sort();
    expect(branches).toEqual(["refs/heads/feature", "refs/heads/main", "refs/heads/topic", "refs/tags/v1.0"]);

    const logOf = async (dir: string, ref: string) =>
      flatOf(await sh(dir, `git log --format="%s|%P" ${ref}`)).sort();
    expect(await logOf(outDir, "main")).toEqual(await logOf(gitDir, "main"));
    expect(await logOf(outDir, "topic")).toEqual(await logOf(gitDir, "topic"));

    await sh(outDir, "git checkout -q main");
    const mainTrees = async (dir: string) =>
      (await sh(dir, "git ls-tree -r main")).split("\n").filter(Boolean).sort();
    expect(await mainTrees(outDir)).toEqual(await mainTrees(gitDir));

    for (const path of ["a.txt", "sub/b.txt", "c.txt"]) {
      const content = (dir: string) => sh(dir, `git show main:${path}`);
      expect(await content(outDir)).toEqual(await content(gitDir));
    }
    expect(await sh(outDir, "git ls-tree main run.sh")).toBe(await sh(gitDir, "git ls-tree main run.sh"));
    expect((await sh(outDir, "git ls-tree -r main")).includes("100755")).toBe(true);

    const authors = async (dir: string) => flatOf(await sh(dir, 'git log --format="%an|%ae" main')).sort();
    expect(await authors(outDir)).toEqual(await authors(gitDir));
  });

  test("round-trips through a second Javelin repo with identical content", async () => {
    const gitDir = join(base, "src-repo");
    const jvl1 = join(base, "jvl1");
    const jvl2 = join(base, "jvl2");
    const outDir = join(base, "out-repo");
    await makeGitRepo(gitDir);
    await importFromGit(gitDir, jvl1);
    await exportToGit(jvl1, outDir);
    const second = await importFromGit(outDir, jvl2);
    expect(second.warnings).toEqual([]);

    const { openRepository } = await import("@javelin/vcs");
    const [r1, r2] = [await openRepository(jvl1), await openRepository(jvl2)];
    const heads = [r1, r2].map(async (r) => {
      const head = (await r.refs.get("refs/heads/main"))!;
      const files = await r.readCommitTree(head);
      const out: Record<string, string> = {};
      for (const [path, id] of Object.entries(files)) {
        out[path] = new TextDecoder().decode(await r.readBlob(id));
      }
      return out;
    });
    expect(await heads[1]).toEqual(await heads[0]);
    expect(second.commits).toBe(5);
  });
});
