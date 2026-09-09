import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type JavelindServer } from "../apps/javelind/src/server";
import { JavelinClient } from "../packages/sdk/src/index";
import { importFromGit } from "../packages/git-bridge/src/index";

let work: string;
let server: JavelindServer;
let client: JavelinClient;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "javelin-ops-backup-"));
  server = createServer({ root: join(work, "server-root"), port: 0 });
  client = new JavelinClient({ baseUrl: `http://localhost:${server.port}` });
});

afterAll(() => {
  server.stop();
  rmSync(work, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
  return out;
}

async function seedGitRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "ops@test"]);
  await git(dir, ["config", "user.name", "ops"]);
  writeFileSync(join(dir, "README.md"), "hello ops\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "first commit"]);
  writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "second commit"]);
}

async function seedServerRepo(name: string): Promise<void> {
  await client.createRepo({ name });
  const gitDir = join(work, `${name}-git`);
  await seedGitRepo(gitDir);
  const result = await importFromGit(gitDir, join(work, "server-root", name));
  expect(result.warnings).toEqual([]);
  expect(result.counts.states).toBe(2);
}

describe("backup/restore round trip", () => {
  test("restore recreates heads, objects and log identical to the pre-backup state", async () => {
    await seedServerRepo("proj");
    const headsBefore = await client.getHeads("proj");
    const worldBefore = headsBefore.world!;
    const logBefore = await client.statesLog("proj", { start: worldBefore, limit: 10 });
    const fetchedBefore = await client.batchFetch("proj", [worldBefore]);
    expect(fetchedBefore.objects).toHaveLength(1);

    const { backupRoot } = await import("./backup");
    const { restoreRoot } = await import("./restore");
    const { archivePath } = await backupRoot(join(work, "server-root"), join(work, "archive"));

    rmSync(join(work, "server-root"), { recursive: true, force: true });
    await expect(client.getHeads("proj")).rejects.toThrow();

    const repos = await restoreRoot(archivePath, join(work, "server-root"));
    expect(repos).toEqual(["proj"]);

    const headsAfter = await client.getHeads("proj");
    expect(headsAfter.world).toBe(worldBefore);
    expect(headsAfter.layers).toEqual(headsBefore.layers);
    const logAfter = await client.statesLog("proj", { start: worldBefore, limit: 10 });
    expect(logAfter.entries).toEqual(logBefore.entries);
    const fetchedAfter = await client.batchFetch("proj", [worldBefore]);
    expect(fetchedAfter.objects).toEqual(fetchedBefore.objects);
  });
});
