import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type JavelindServer } from "../apps/javelind/src/server";
import { createWebServer, type WebServer } from "../apps/web/src/server";
import { JavelinClient } from "../packages/sdk/src/index";
import { importFromGit } from "../packages/git-bridge/src/index";
import { openRepository } from "../packages/vcs/src/index";
import { objectId } from "../packages/protocol/src/index";
import { recordRun } from "../packages/provenance/src/index";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI = join(REPO_ROOT, "apps", "cli", "src", "main.ts");

let work: string;
let javelind: JavelindServer;
let web: WebServer;
let client: JavelinClient;
let javelindUrl: string;
let webUrl: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "javelin-ops-e2e-"));
  javelind = createServer({ root: join(work, "javelind-root"), port: 0 });
  javelindUrl = `http://localhost:${javelind.port}`;
  web = createWebServer({ javelindUrl, port: 0 });
  webUrl = `http://localhost:${web.port}`;
  client = new JavelinClient({ baseUrl: javelindUrl });
});

afterAll(() => {
  javelind.stop();
  web.stop();
  rmSync(work, { recursive: true, force: true });
});

async function run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
  return out;
}

describe("platform end to end", () => {
  let worldAfterSeed: string;
  let stateViaCliId: ReturnType<typeof objectId> | undefined;

  test("git repo imports via git-bridge into javelind as World", async () => {
    await client.createRepo({ name: "app", description: "e2e repo" });
    const gitDir = join(work, "seed-git");
    mkdirSync(gitDir, { recursive: true });
    await git(gitDir, ["init", "-b", "main"]);
    await git(gitDir, ["config", "user.email", "e2e@test"]);
    await git(gitDir, ["config", "user.name", "e2e"]);
    writeFileSync(join(gitDir, "README.md"), "hello javelin e2e\n");
    mkdirSync(join(gitDir, "src"));
    writeFileSync(join(gitDir, "src", "util.ts"), "export function greet() { return 'hi'; }\n");
    await git(gitDir, ["add", "."]);
    await git(gitDir, ["commit", "-m", "seed: add readme and util"]);
    const result = await importFromGit(gitDir, join(work, "javelind-root", "app"));
    expect(result.warnings).toEqual([]);
    expect(result.counts.states).toBe(1);
    worldAfterSeed = (await client.getHeads("app")).world!;
    expect(worldAfterSeed).toBeDefined();
  });

  test("CLI clones, checkpoints a layer, publishes; second clone pulls the new World", async () => {
    const cloneA = join(work, "clone-a");
    const cloneB = join(work, "clone-b");
    expect((await run(["clone", `${javelindUrl}/app`, cloneA], work)).code).toBe(0);
    expect((await run(["clone", `${javelindUrl}/app`, cloneB], work)).code).toBe(0);
    expect(await Bun.file(join(cloneA, "src", "util.ts")).text()).toContain("greet");

    expect((await run(["layer", "new", "cli-work"], cloneA)).code).toBe(0);
    writeFileSync(join(cloneA, "src", "extra.txt"), "pushed via cli\n");
    expect((await run(["checkpoint", "-m", "cli: add extra file"], cloneA)).code).toBe(0);
    const contributed = await run(["contribute", "-t", "cli change"], cloneA);
    expect(contributed.code).toBe(0);
    const contributionId = contributed.stdout.match(/[0-9a-f]{64}/)![0];
    const published = await run(["publish", contributionId], cloneA);
    expect(published.code).toBe(0);
    expect(published.stdout).toContain("published");

    const pull = await run(["pull"], cloneB);
    expect(pull.code).toBe(0);
    expect(await Bun.file(join(cloneB, "src", "extra.txt")).text()).toContain("pushed via cli");

    stateViaCliId = objectId((await run(["status"], cloneB)).stdout.match(/world: ([0-9a-f]{64})/)![1]!);
    const log = await client.statesLog("app", { start: stateViaCliId!, limit: 10 });
    expect(log.entries.some((s) => s.message.includes("cli: add extra file"))).toBe(true);
  });

  test("SDK searches code and history", async () => {
    const code = await client.search("app", { query: "greet", kind: "code" });
    expect(code.hits.length).toBeGreaterThan(0);
    expect(code.hits[0]!.kind).toBe("code");
    const history = await client.search("app", { query: "cli: add extra file", kind: "history" });
    expect(history.hits.length).toBeGreaterThan(0);
  });

  test("provenance recorded against a published state is searchable", async () => {
    const repo = await openRepository(join(work, "javelind-root", "app"));
    await recordRun(repo, {
      states: [objectId(stateViaCliId!)],
      agent: { name: "e2e-bot", adapter: "generic" },
      startedAt: new Date().toISOString(),
      exit: "success",
      summary: "ran the e2e scenario",
    });
    const prov = await client.search("app", { query: "e2e-bot", kind: "provenance" });
    expect(prov.hits.length).toBeGreaterThan(0);
  });

  test("web renders home, repo, world log, state, browse, and blob pages", async () => {
    const home = await (await fetch(webUrl)).text();
    expect(home).toContain("app");
    const repoPage = await (await fetch(`${webUrl}/app`)).text();
    expect(repoPage).toContain("app");
    const world = await (await fetch(`${webUrl}/app/world`)).text();
    expect(world).toContain("cli: add extra file");
    const statePage = await (await fetch(`${webUrl}/app/state/${stateViaCliId}`)).text();
    expect(statePage).toContain("publish cli-work: cli change");
    expect(statePage).toContain("Changed files");
    const browse = await (await fetch(`${webUrl}/app/browse/world`)).text();
    expect(browse).toContain("README.md");
    expect(browse).toContain("/app/browse/world/src");
    const srcPage = await (await fetch(`${webUrl}/app/browse/world/src`)).text();
    const blobLink = srcPage.match(/href="(\/app\/blob\/[0-9a-f]{64}\/src\/util\.ts)"/);
    expect(blobLink).not.toBeNull();
    const blob = await (await fetch(`${webUrl}${blobLink![1]}`)).text();
    expect(blob).toContain("greet");
  });

  test("backup and restore preserve the served state", async () => {
    const root = join(work, "javelind-root");
    const headsBefore = await client.getHeads("app");
    const logBefore = await client.statesLog("app", { start: headsBefore.world!, limit: 10 });

    const { backupRoot } = await import("./backup");
    const { restoreRoot } = await import("./restore");
    const { archivePath } = await backupRoot(root, join(work, "archive"));
    rmSync(root, { recursive: true, force: true });
    await expect(client.getHeads("app")).rejects.toThrow();
    const repos = await restoreRoot(archivePath, root);
    expect(repos).toEqual(["app"]);

    const headsAfter = await client.getHeads("app");
    expect(headsAfter.world).toBe(headsBefore.world);
    expect(await client.statesLog("app", { start: headsBefore.world!, limit: 10 })).toEqual(logBefore);
    const page = await (await fetch(`${webUrl}/app/world`)).text();
    expect(page).toContain("cli: add extra file");
  });
});
