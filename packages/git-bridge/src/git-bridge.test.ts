import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectId } from "@javelin/protocol";
import { openRepository } from "@javelin/vcs";
import { exportToGit, importFromGit } from "./index";

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

const ENV = 'GIT_AUTHOR_DATE="2026-01-01T00:00:00 +0000" GIT_COMMITTER_DATE="2026-01-01T00:00:00 +0000"';

async function makeGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await sh(dir, `
    git init -q -b main .
    git config user.name "Alice Dev"
    git config user.email "alice@example.com"
    echo "hello v2" > a.txt
    mkdir sub && echo "nested content" > sub/b.txt
    echo "#!/bin/sh" > run.sh && chmod +x run.sh
    echo real > target.txt && ln -s target.txt link.txt
    git add . && ${ENV} git commit -q -m "initial commit"
    git checkout -qb feature
    echo "feature line" >> a.txt
    git add . && ${ENV} git commit -q -m "feature work"
    git checkout -q main
    echo "main line" > c.txt
    git add . && ${ENV} git commit -q -m "main work"
    ${ENV} git merge -q --no-ff feature -m "merge feature into main"
    ${ENV} git tag -a v1.0 -m "release v1.0"
    git checkout -qb topic
    echo "topic" > t.txt
    git add . && ${ENV} git commit -q -m "topic commit"
    git checkout -q main
  `);
}

interface FlatFile {
  mode: string;
  content: string;
}

const GIT_MODE_NAMES: Record<string, string> = { "100644": "file", "100755": "exec", "120000": "symlink" };

/** Flatten any state into path -> { mode name, decoded content }. */
async function flattenState(jvlDir: string, stateId: ObjectId): Promise<Record<string, FlatFile>> {
  const repo = await openRepository(jvlDir);
  const state = await repo.loadState(stateId);
  const out: Record<string, FlatFile> = {};
  const walk = async (treeId: ObjectId, dir: string): Promise<void> => {
    for (const entry of (await repo.loadTree(treeId)).entries) {
      const full = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === "tree") {
        await walk(entry.id, full);
      } else {
        out[full] = {
          mode: entry.mode,
          content: new TextDecoder().decode(await repo.readBlob(entry.id)),
        };
      }
    }
  };
  await walk(state.tree, "");
  return out;
}

async function gitTree(dir: string, ref: string): Promise<Record<string, FlatFile>> {
  const raw = await sh(dir, `git ls-tree -r -z ${ref}`);
  const out: Record<string, FlatFile> = {};
  for (const record of raw.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, , hash] = record.slice(0, tab).split(" ") as [string, string, string];
    out[record.slice(tab + 1)] = {
      mode: GIT_MODE_NAMES[mode] ?? mode,
      content: await sh(dir, `git cat-file blob ${hash}`),
    };
  }
  return out;
}

describe("importFromGit", () => {
  test("imports mainline into World with modes, layers per branch, and merge parents", async () => {
    const gitDir = join(base, "src-repo");
    const jvlDir = join(base, "jvl");
    await makeGitRepo(gitDir);

    const report = await importFromGit(gitDir, jvlDir);
    expect(report.warnings).toEqual([]);
    expect(report.counts.states).toBe(5);
    expect(report.counts.branches).toBe(2);

    const repo = await openRepository(jvlDir);
    expect(report.worldHead).not.toBeNull();
    const world = report.worldHead!;
    expect(await repo.worldHead()).toBe(world);

    const worldHead = await repo.loadState(world);
    expect(worldHead.message).toContain("merge feature into main");
    expect(worldHead.author).toEqual({ name: "Alice Dev", email: "alice@example.com", time: "2026-01-01T00:00:00.000Z" });
    expect(worldHead.parents).toHaveLength(2);

    const mergeParents = await Promise.all(worldHead.parents.map((p) => repo.loadState(p)));
    expect(mergeParents.map((s) => s.message).sort()).toEqual(["feature work\n", "main work\n"]);
    for (const parent of mergeParents) expect(parent.parents).toHaveLength(1);

    expect(await flattenState(jvlDir, world)).toEqual(await gitTree(gitDir, "main"));
    const runMode = (await gitTree(gitDir, "main"))["run.sh"]!.mode;
    expect(runMode).toBe("exec");
    const link = (await flattenState(jvlDir, world))["link.txt"]!;
    expect(link.mode).toBe("symlink");
    expect(link.content).toBe("target.txt");

    const feature = await repo.layerGet("feature");
    const topic = await repo.layerGet("topic");
    expect(feature).not.toBeNull();
    expect(topic).not.toBeNull();
    const featureHead = await repo.loadState(feature!.head!);
    expect(featureHead.message).toBe("feature work\n");
    expect(feature!.base).toBe(feature!.head!);
    const featureFiles = await flattenState(jvlDir, feature!.head!);
    expect(featureFiles["a.txt"]!.content).toBe("hello v2\nfeature line\n");
    expect(featureFiles["c.txt"]).toBeUndefined();

    expect((await repo.loadState(topic!.base!)).message).toBe("merge feature into main\n");
    expect((await repo.loadState(topic!.head!)).message).toBe("topic commit\n");
    expect(report.layers.map((l) => l.name).sort()).toEqual(["feature", "topic"]);

    expect(report.tags["v1.0"]).toBe(world);
    const map = JSON.parse(await readFile(join(jvlDir, ".javelin", "bridge-map.json"), "utf8"));
    expect(Object.keys(map.commits)).toHaveLength(5);
    expect(map.tags["v1.0"]).toBe(world);
    const marker = JSON.parse(await readFile(join(jvlDir, ".javelin", "bridge.json"), "utf8"));
    expect(marker).toMatchObject({ mode: "adoption", authority: "github" });
  });

  test("is a no-op on a second full import", async () => {
    const gitDir = join(base, "src-repo");
    const jvlDir = join(base, "jvl");
    await makeGitRepo(gitDir);

    const first = await importFromGit(gitDir, jvlDir);
    const mapBefore = await readFile(join(jvlDir, ".javelin", "bridge-map.json"), "utf8");

    const second = await importFromGit(gitDir, jvlDir);
    expect(second.counts.imported).toBe(0);
    expect(second.worldHead).toBe(first.worldHead);
    expect(second.counts.states).toBe(first.counts.states);
    expect(second.warnings).toEqual([]);
    expect(await readFile(join(jvlDir, ".javelin", "bridge-map.json"), "utf8")).toBe(mapBefore);
  });

  test("imports only new commits incrementally and advances the world head", async () => {
    const gitDir = join(base, "src-repo");
    const jvlDir = join(base, "jvl");
    await makeGitRepo(gitDir);

    const first = await importFromGit(gitDir, jvlDir);
    const mapBefore = JSON.parse(await readFile(join(jvlDir, ".javelin", "bridge-map.json"), "utf8"));

    await sh(gitDir, `
      echo "more main" >> c.txt
      git add . && ${ENV} git commit -q -m "second main work"
    `);

    const second = await importFromGit(gitDir, jvlDir);
    expect(second.warnings).toEqual([]);
    expect(second.counts.imported).toBe(1);
    expect(second.counts.states).toBe(first.counts.states + 1);
    const mapAfter = JSON.parse(await readFile(join(jvlDir, ".javelin", "bridge-map.json"), "utf8"));
    expect(Object.keys(mapAfter.commits)).toHaveLength(Object.keys(mapBefore.commits).length + 1);

    const repo = await openRepository(jvlDir);
    const head = await repo.loadState(second.worldHead!);
    expect(head.message).toBe("second main work\n");
    expect(head.parents).toEqual([first.worldHead!]);
    const content = await flattenState(jvlDir, second.worldHead!);
    expect(content["c.txt"]!.content).toBe("main line\nmore main\n");

    const third = await importFromGit(gitDir, jvlDir);
    expect(third.counts.imported).toBe(0);
    expect(third.worldHead).toBe(second.worldHead);
  });
});

describe("exportToGit round-trip", () => {
  test("exported git repo matches original structure, authors, modes, and contents", async () => {
    const gitDir = join(base, "src-repo");
    const jvlDir = join(base, "jvl");
    const outDir = join(base, "out-repo");
    await makeGitRepo(gitDir);
    const report = await importFromGit(gitDir, jvlDir);

    const result = await exportToGit(jvlDir, outDir);
    expect(result.warnings).toEqual([]);
    expect(result.commits).toBe(5);
    expect(Object.keys(result.refs).sort()).toEqual(["refs/heads/feature", "refs/heads/main", "refs/heads/topic"]);

    const branches = (await sh(outDir, "git for-each-ref --format='%(refname)' refs/heads")).trim().split("\n").sort();
    expect(branches).toEqual(["refs/heads/feature", "refs/heads/main", "refs/heads/topic"]);

    const shape = async (dir: string, ref: string) =>
      (await sh(dir, `git log --format='%s|%P' ${ref}`)).trim().split("\n").map((l) => {
        const [subject, parents] = l.split("|");
        return `${subject}|${parents!.split(" ").filter(Boolean).length}`;
      }).sort();
    expect(await shape(outDir, "main")).toEqual(await shape(gitDir, "main"));
    expect(await shape(outDir, "feature")).toEqual(await shape(gitDir, "feature"));
    expect(await shape(outDir, "topic")).toEqual(await shape(gitDir, "topic"));

    const authors = async (dir: string) =>
      (await sh(dir, 'git log --format="%an|%ae" main')).trim().split("\n").sort();
    expect(await authors(outDir)).toEqual(await authors(gitDir));

    expect(await gitTree(outDir, "main")).toEqual(await gitTree(gitDir, "main"));
    expect((await sh(outDir, "git ls-tree main")).includes("100755")).toBe(true);
    expect(await sh(outDir, "git show main:link.txt")).toBe(await sh(gitDir, "git show main:link.txt"));
    expect((await sh(outDir, "git ls-tree main link.txt")).includes("120000")).toBe(true);
    await sh(outDir, "git checkout -q main");
    expect((await sh(outDir, "readlink link.txt")).trim()).toBe("target.txt");

    const marker = JSON.parse(await readFile(join(jvlDir, ".javelin", "bridge.json"), "utf8"));
    expect(marker).toMatchObject({ mode: "native", authority: "javelin" });
  });

  test("re-importing the export produces identical world content", async () => {
    const gitDir = join(base, "src-repo");
    const jvlDir1 = join(base, "jvl1");
    const jvlDir2 = join(base, "jvl2");
    const outDir = join(base, "out-repo");
    await makeGitRepo(gitDir);
    const first = await importFromGit(gitDir, jvlDir1);
    await exportToGit(jvlDir1, outDir);
    const second = await importFromGit(outDir, jvlDir2);
    expect(second.warnings).toEqual([]);
    expect(second.counts.states).toBe(5);

    const world1 = await flattenState(jvlDir1, first.worldHead!);
    const world2 = await flattenState(jvlDir2, second.worldHead!);
    expect(world2).toEqual(world1);
    expect(Object.keys(world1).sort()).toEqual(["a.txt", "c.txt", "link.txt", "run.sh", "sub/b.txt", "target.txt"]);
  });
});
