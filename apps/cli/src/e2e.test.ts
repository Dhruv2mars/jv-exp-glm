import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type JavelindServer } from "../../javelind/src/server";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "apps", "cli", "src", "main.ts");

let work: string;
let server: JavelindServer;
let baseUrl: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "javelin-cli-e2e-"));
  server = createServer({ root: join(work, "server-data"), port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
  rmSync(work, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("e2e with javelind", () => {
  const a = () => join(work, "a");
  const b = () => join(work, "b");

  test("init, add, commit, log shows the commit", async () => {
    mkdirSync(a(), { recursive: true });
    const init = await run(["init"], a());
    expect(init.code).toBe(0);

    writeFileSync(join(a(), "hello.txt"), "hello world");
    expect((await run(["add", "hello.txt"], a())).code).toBe(0);
    const commit = await run(["commit", "-m", "first"], a());
    expect(commit.code).toBe(0);
    expect(commit.stdout).toContain("first");

    const log = await run(["log"], a());
    expect(log.code).toBe(0);
    expect(log.stdout).toContain("first");
    expect(log.stdout).toMatch(/commit [0-9a-f]{64}/);
  });

  test("push uploads objects and moves the remote ref", async () => {
    const url = `${baseUrl}/a`;
    const add = await run(["remote", "add", "origin", url], a());
    expect(add.code).toBe(0);
    const push = await run(["push"], a());
    expect(push.code).toBe(0);
    expect(push.stdout).toContain("pushed");
  });

  test("clone into a second dir matches file contents", async () => {
    const clone = await run(["clone", `${baseUrl}/a`, b()], work);
    expect(clone.code).toBe(0);
    expect(readFileSync(join(b(), "hello.txt"), "utf8")).toBe("hello world");

    const logB = await run(["log"], b());
    expect(logB.stdout).toContain("first");
  });

  test("pull propagates a new commit from the first repo", async () => {
    writeFileSync(join(a(), "second.txt"), "second");
    expect((await run(["add", "second.txt"], a())).code).toBe(0);
    expect((await run(["commit", "-m", "second commit"], a())).code).toBe(0);
    const push = await run(["push"], a());
    expect(push.code).toBe(0);

    const pull = await run(["pull"], b());
    expect(pull.code).toBe(0);
    expect(readFileSync(join(b(), "second.txt"), "utf8")).toBe("second");
    const logB = await run(["log"], b());
    expect(logB.stdout).toContain("second commit");
  });

  test("non-fast-forward push is rejected", async () => {
    writeFileSync(join(b(), "diverge.txt"), "b-side");
    expect((await run(["add", "diverge.txt"], b())).code).toBe(0);
    expect((await run(["commit", "-m", "b-side commit"], b())).code).toBe(0);

    writeFileSync(join(a(), "ahead.txt"), "a-side");
    expect((await run(["add", "ahead.txt"], a())).code).toBe(0);
    expect((await run(["commit", "-m", "a-side commit"], a())).code).toBe(0);
    expect((await run(["push"], a())).code).toBe(0);

    const push = await run(["push"], b());
    expect(push.code).toBe(1);
    expect(push.stderr).toContain("non-fast-forward");
  });

  test("push with no configured remote fails on stderr", async () => {
    const c = join(work, "c");
    mkdirSync(c, { recursive: true });
    await run(["init"], c);
    const res = await run(["status"], c);
    expect(res.code).toBe(0);
    const push = await run(["push"], c);
    expect(push.code).toBe(1);
    expect(push.stderr).toContain("no remote named");
  });
});
