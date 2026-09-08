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
import { recordProvenance } from "../packages/provenance/src/index";

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
  let headId: string;
  let commitViaCliId: string;

  test("git repo imports via git-bridge into javelind", async () => {
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
    expect(result.commits).toBe(1);
    headId = result.refs["refs/heads/main"]!;
    expect(headId).toBeDefined();
  });

  test("CLI clones, commits, pushes; second clone pulls", async () => {
    const cloneA = join(work, "clone-a");
    const cloneB = join(work, "clone-b");
    const cloneA2 = await run(["clone", `${javelindUrl}/app`, cloneA], work);
    expect(cloneA2.code).toBe(0);
    const cloneB2 = await run(["clone", `${javelindUrl}/app`, cloneB], work);
    expect(cloneB2.code).toBe(0);
    expect(await Bun.file(join(cloneA, "src", "util.ts")).text()).toContain("greet");

    writeFileSync(join(cloneA, "src", "extra.txt"), "pushed via cli\n");
    const add = await run(["add", "."], cloneA);
    expect(add.code).toBe(0);
    const commit = await run(["commit", "-m", "cli: add extra file"], cloneA);
    expect(commit.code).toBe(0);
    const push = await run(["push", "origin"], cloneA);
    expect(push.code).toBe(0);

    const pull = await run(["pull", "origin"], cloneB);
    expect(pull.code).toBe(0);
    expect(await Bun.file(join(cloneB, "src", "extra.txt")).text()).toContain("pushed via cli");

    const refs = (await client.listRefs("app")).refs;
    commitViaCliId = refs["refs/heads/main"]!;
    expect(commitViaCliId).not.toBe(headId);
  });

  test("SDK searches code and history", async () => {
    const code = await client.search("app", "greet", { kind: "code" });
    expect(code.hits.length).toBeGreaterThan(0);
    expect(code.hits[0]!.kind).toBe("code");
    const history = await client.search("app", "cli: add extra file", { kind: "history" });
    expect(history.hits.length).toBeGreaterThan(0);
    expect(String(history.hits[0]!.commit)).toBe(commitViaCliId);
  });

  test("provenance recorded on a commit is searchable", async () => {
    const repo = await openRepository(join(work, "javelind-root", "app"));
    const result = await recordProvenance(repo, objectId(commitViaCliId), {
      kind: "provenance",
      agent: { name: "e2e-bot", adapter: "generic" },
      startedAt: new Date().toISOString(),
      exit: "success",
      summary: "ran the e2e scenario",
    });
    expect(result.attached).toBe(true);
    const refs = (await client.listRefs("app")).refs;
    commitViaCliId = refs["refs/heads/main"]!;
    const prov = await client.search("app", "e2e-bot", { kind: "provenance" });
    expect(prov.hits.length).toBeGreaterThan(0);
  });

  test("web renders home, repo, commits, commit, and browse pages", async () => {
    const home = await (await fetch(webUrl)).text();
    expect(home).toContain("app");
    const repoPage = await (await fetch(`${webUrl}/app`)).text();
    expect(repoPage).toContain("Browse files");
    const commits = await (await fetch(`${webUrl}/app/commits`)).text();
    expect(commits).toContain("cli: add extra file");
    const commitPage = await (await fetch(`${webUrl}/app/commit/${commitViaCliId}`)).text();
    expect(commitPage).toContain("cli: add extra file");
    const browse = await (await fetch(`${webUrl}/app/browse/main`)).text();
    expect(browse).toContain("README.md");
    const blob = await (await fetch(`${webUrl}/app/blob/main/src/util.ts`)).text();
    expect(blob).toContain("greet");
  });

  test("backup and restore preserve the served state", async () => {
    const root = join(work, "javelind-root");
    const refsBefore = (await client.listRefs("app")).refs;
    const logBefore = await client.log("app", refsBefore["refs/heads/main"]!, 10);

    const { backupRoot } = await import("./backup");
    const { restoreRoot } = await import("./restore");
    const { archivePath } = await backupRoot(root, join(work, "archive"));
    rmSync(root, { recursive: true, force: true });
    await expect(client.listRefs("app")).rejects.toThrow();
    const repos = await restoreRoot(archivePath, root);
    expect(repos).toEqual(["app"]);

    expect((await client.listRefs("app")).refs).toEqual(refsBefore);
    expect(await client.log("app", refsBefore["refs/heads/main"]!, 10)).toEqual(logBefore);
    const page = await (await fetch(`${webUrl}/app/commits`)).text();
    expect(page).toContain("cli: add extra file");
  });
});
