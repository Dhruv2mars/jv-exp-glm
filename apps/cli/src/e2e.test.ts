import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectId, type ObjectId } from "@javelin/protocol";
import { createServer, type JavelindServer } from "../../javelind/src/server";
import { JavelinClient } from "@javelin/sdk";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "apps", "cli", "src", "main.ts");
const TOKEN = "e2e-token";
const BIN = Uint8Array.from([0x00, 0x80, 0xff, 0x00, 0x80, 0xff]);

let work: string;
let server: JavelindServer;
let baseUrl: string;
let url: string;
let client: JavelinClient;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "javelin-cli-e2e-"));
  server = createServer({ root: join(work, "server-data"), port: 0, token: TOKEN });
  baseUrl = `http://localhost:${server.port}`;
  url = `${baseUrl}/demo`;
  client = new JavelinClient({ baseUrl, token: TOKEN });
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
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, JAVELIN_TOKEN: TOKEN, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com" },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

function dir(name: string): string {
  const path = join(work, name);
  mkdirSync(path, { recursive: true });
  return path;
}

async function contribute(cwd: string, title: string): Promise<string> {
  const res = await run(["contribute", "-t", title], cwd);
  expect(res.code).toBe(0);
  return res.stdout.match(/[0-9a-f]{64}/)![0];
}

describe("e2e with javelind", () => {
  test("server rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/jrp/v2/repos`, { headers: { "x-jrp-version": "2" } });
    expect(res.status).toBe(401);
  });

  test("checkpoint, contribute, and publish land the layer on the remote world", async () => {
    const a = dir("a");
    expect((await run(["init"], a)).code).toBe(0);
    expect((await run(["layer", "new", "work"], a)).code).toBe(0);

    writeFileSync(join(a, "hello.txt"), "hello world\n");
    writeFileSync(join(a, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(a, "run.sh"), 0o755);
    writeFileSync(join(a, "blob.bin"), BIN);

    const status = await run(["status"], a);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("layer: work");
    expect(status.stdout).toMatch(/added\s+hello\.txt/);

    expect((await run(["checkpoint", "-m", "first checkpoint"], a)).code).toBe(0);
    expect((await run(["status"], a)).stdout).toContain("working tree clean");
    const log = await run(["log", "--layer", "work"], a);
    expect(log.stdout).toContain("first checkpoint");

    const contribution = await contribute(a, "first change");
    expect((await run(["remote", "add", "origin", url, "--token", TOKEN], a)).code).toBe(0);
    const publish = await run(["publish", contribution], a);
    expect(publish.code).toBe(0);
    expect(publish.stdout).toContain("published");

    const heads = await client.getHeads("demo");
    expect(heads.world).toMatch(/[0-9a-f]{64}/);
  });

  test("clone materializes the world byte-for-byte, including exec and binary files", async () => {
    const b = join(work, "b");
    const clone = await run(["clone", url, b], work);
    expect(clone.code).toBe(0);
    expect(readFileSync(join(b, "hello.txt"), "utf8")).toBe("hello world\n");
    expect(Buffer.compare(readFileSync(join(b, "blob.bin")), Buffer.from(BIN))).toBe(0);
    expect(statSync(join(b, "run.sh")).mode & 0o111).not.toBe(0);

    const status = await run(["status"], b);
    expect(status.stdout).toContain("working tree clean");
  });

  test("a second clone publishes and the first clone pulls the new world", async () => {
    const b = join(work, "b");
    expect((await run(["layer", "new", "work"], b)).code).toBe(0);
    writeFileSync(join(b, "second.txt"), "second\n");
    expect((await run(["checkpoint", "-m", "second checkpoint"], b)).code).toBe(0);
    const contribution = await contribute(b, "second change");
    const publish = await run(["publish", contribution], b);
    expect(publish.code).toBe(0);

    const a = join(work, "a");
    const pull = await run(["pull"], a);
    expect(pull.code).toBe(0);
    expect(readFileSync(join(a, "second.txt"), "utf8")).toBe("second\n");
    expect(readFileSync(join(a, "hello.txt"), "utf8")).toBe("hello world\n");
  });

  test("concurrent publishes: one wins, the other retries against the moved world", async () => {
    const c = join(work, "c");
    const d = join(work, "d");
    expect((await run(["clone", url, c], work)).code).toBe(0);
    expect((await run(["clone", url, d], work)).code).toBe(0);
    expect((await run(["layer", "new", "c"], c)).code).toBe(0);
    writeFileSync(join(c, "c.txt"), "from-c\n");
    expect((await run(["checkpoint", "-m", "c edit"], c)).code).toBe(0);
    const contributionC = await contribute(c, "c change");

    expect((await run(["layer", "new", "d"], d)).code).toBe(0);
    writeFileSync(join(d, "d.txt"), "from-d\n");
    expect((await run(["checkpoint", "-m", "d edit"], d)).code).toBe(0);
    const contributionD = await contribute(d, "d change");

    const [pc, pd] = await Promise.all([run(["publish", contributionC], c), run(["publish", contributionD], d)]);
    expect(pc.code).toBe(0);
    expect(pd.code).toBe(0);

    const e = join(work, "e");
    expect((await run(["clone", url, e], work)).code).toBe(0);
    expect(readFileSync(join(e, "c.txt"), "utf8")).toBe("from-c\n");
    expect(readFileSync(join(e, "d.txt"), "utf8")).toBe("from-d\n");
  });

  test("push syncs a locally published world, and a clone of it matches byte-for-byte", async () => {
    const p = dir("push-src");
    expect((await run(["clone", url, p], work)).code).toBe(0);
    expect((await run(["layer", "new", "local"], p)).code).toBe(0);
    writeFileSync(join(p, "push.txt"), "pushed\n");
    writeFileSync(join(p, "push.bin"), BIN);
    expect((await run(["checkpoint", "-m", "local work"], p)).code).toBe(0);
    const contribution = await contribute(p, "local change");
    const localPublish = await run(["publish", contribution], p);
    expect(localPublish.code).toBe(0);
    expect(localPublish.stdout).toContain("published");
    const localWorld = objectId((await run(["status"], p)).stdout.match(/world: ([0-9a-f]{64})/)![1]!);

    const push = await run(["push"], p);
    expect(push.code).toBe(0);
    expect(push.stdout).toContain("world up to date");
    expect(push.stdout).toContain("layer local ->");

    const heads = await client.getHeads("demo");
    expect(heads.world).toBe(localWorld);
    const remoteContribs = await client.listContributions("demo", { status: "published" });
    expect(remoteContribs.contributions.some((c) => c.title === "local change")).toBe(true);

    const f = join(work, "f");
    expect((await run(["clone", url, f], work)).code).toBe(0);
    expect(readFileSync(join(f, "push.txt"), "utf8")).toBe("pushed\n");
    expect(Buffer.compare(readFileSync(join(f, "push.bin")), Buffer.from(BIN))).toBe(0);
  });

  test("fetch updates remote-tracking meta without moving the local world", async () => {
    const a = join(work, "a");
    const worldBefore = objectId((await run(["status"], a)).stdout.match(/world: ([0-9a-f]{64})/)![1]!);
    const fetch = await run(["fetch"], a);
    expect(fetch.code).toBe(0);
    expect(fetch.stdout).toContain("remote-tracking meta updated");
    const worldAfter = objectId((await run(["status"], a)).stdout.match(/world: ([0-9a-f]{64})/)![1]!);
    expect(worldAfter).toBe(worldBefore);
    expect(existsSync(join(a, ".javelin", "meta", "remote", "origin", "world"))).toBe(true);
  });

  test("publish with an invalid id exits 1 on stderr", async () => {
    const res = await run(["publish", "nothex"], join(work, "a"));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("invalid contribution id");
  });
});
