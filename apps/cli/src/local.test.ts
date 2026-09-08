import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdAdd, cmdBranch, cmdCheckout, cmdCommit, cmdDiff, cmdInit, cmdLog, cmdMerge, cmdStatus } from "./local";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "javelin-cli-local-"));
  mkdirSync(join(root, "repo"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("local-only flow", () => {
  test("init, add, commit, log", async () => {
    const repo = join(root, "repo");
    await cmdInit(repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "a.txt"), "hello");
    writeFileSync(join(repo, "src", "b.txt"), "world");
    expect(await cmdAdd(repo, ["a.txt", "src"])).toContain("2 files");

    const status = await cmdStatus(repo);
    expect(status).toContain("staged:  added  a.txt");

    const commitOut = await cmdCommit(repo, "first commit");
    expect(commitOut).toContain("first commit");

    const log = await cmdLog(repo);
    expect(log).toContain("first commit");
    expect(log).toMatch(/commit [0-9a-f]{64}/);
  });

  test("status is clean after commit, diff shows modifications", async () => {
    const repo = join(root, "repo");
    expect(await cmdStatus(repo)).toContain("nothing to commit");
    writeFileSync(join(repo, "a.txt"), "changed");
    expect(await cmdDiff(repo)).toContain("modified  a.txt");
    await cmdAdd(repo, ["a.txt"]);
    expect(await cmdDiff(repo)).toContain("modified  a.txt");
    await cmdCommit(repo, "second");
    expect(await cmdDiff(repo)).toContain("no changes");
  });

  test("diff against a ref", async () => {
    const repo = join(root, "repo");
    const log = await cmdLog(repo);
    const firstId = [...log.matchAll(/commit ([0-9a-f]{64})/g)].pop()![1]!;
    expect(await cmdDiff(repo, firstId)).toContain("modified  a.txt");
    expect(await cmdDiff(repo, "main")).toContain("no changes");
  });

  test("branch, checkout, merge across branches", async () => {
    const repo = join(root, "repo");
    await cmdBranch(repo, "feature");
    const listing = await cmdBranch(repo);
    expect(listing).toContain("* main");
    expect(listing).toContain("feature");

    await cmdCheckout(repo, "feature");
    writeFileSync(join(repo, "feature.txt"), "feat");
    await cmdAdd(repo, ["feature.txt"]);
    await cmdCommit(repo, "feature work");

    await cmdCheckout(repo, "main");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed");
    const mergeOut = await cmdMerge(repo, "feature");
    expect(mergeOut).toMatch(/merged feature as [0-9a-f]{64}/);
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feat");
  });

  test("checkout an unknown ref fails", async () => {
    expect(cmdCheckout(root, "nope")).rejects.toThrow("cannot resolve");
  });
});
