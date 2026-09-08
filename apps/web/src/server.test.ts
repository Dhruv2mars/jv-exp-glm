import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectId, type SerializedObject, type UpdateRefsResponse, type UploadObjectsResponse } from "@javelin/protocol";
import { JavelinClient } from "@javelin/sdk";
import { Repository, type StoredObject } from "@javelin/vcs";
import { createServer, type JavelindServer } from "../../../apps/javelind/src/server";
import { createWebServer, type WebServer } from "./server";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function seedRepo(client: JavelinClient, name: string): Promise<void> {
  await client.createRepo({ name, defaultBranch: "main" });
  const dir = await mkdtemp(join(tmpdir(), `web-seed-${name}-`));
  const repo = await Repository.open(dir);
  await repo.stage("hello.txt", enc.encode("hello javelin world\nsecond line\n"));
  await repo.stage("src/nested.txt", enc.encode("nested content alpha\n"));
  await repo.stage("evil.txt", enc.encode("<script>alert(1)</script>\n"));
  const c1 = objectId((await repo.commit({ message: "add hello" })).toString());
  await repo.stage("hello.txt", enc.encode("hello javelin world\nchanged by commit two\n"));
  const c2 = objectId((await repo.commit({ message: "update hello" })).toString());
  const objects: SerializedObject[] = [];
  for (const id of await repo.objects.list()) {
    const obj = await repo.objects.read(id);
    if (!obj) continue;
    objects.push(
      obj.kind === "blob"
        ? { id, kind: "blob" as const, data: dec.decode((obj as Extract<StoredObject, { kind: "blob" }>).data) }
        : ({ id, kind: obj.kind, object: obj } as SerializedObject),
    );
  }
  const up = await client.uploadObjects(name, objects);
  expect(up.rejected).toEqual([]);
  expect(up.accepted.length).toBe(objects.length);
  const refs = await client.updateRefs(name, [
    { ref: "refs/heads/main", expectedOld: null, new: c2 },
  ]);
  expect(refs.results.every((r) => r.ok)).toBe(true);
  void c1;
}

describe("javelin web", () => {
  const cleanup: (() => void)[] = [];
  let web: WebServer;
  let base: string;

  afterAll(async () => {
    for (const fn of cleanup) fn();
  });

  test("setup: javelind + seeded repo + web server", async () => {
    const root = await mkdtemp(join(tmpdir(), "web-javelind-"));
    const javelind: JavelindServer = createServer({ port: 0, root });
    const client = new JavelinClient({ baseUrl: `http://localhost:${javelind.port}` });
    await seedRepo(client, "demo");
    web = createWebServer({ javelindUrl: `http://localhost:${javelind.port}`, port: 0 });
    base = `http://localhost:${web.port}`;
    cleanup.push(() => {
      javelind.stop();
      web.stop();
      void rm(root, { recursive: true, force: true });
    });

    const home = await fetch(base);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("demo");
  });

  test("commits page lists seeded commit messages", async () => {
    const res = await fetch(`${base}/demo/commits`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("add hello");
    expect(body).toContain("update hello");
  });

  test("commit detail lists changed files", async () => {
    const client = new JavelinClient({ baseUrl: base.replace(/:\d+$/, "") });
    void client;
    const log = await fetch(`${base}/demo/commits`);
    const html = await log.text();
    const m = html.match(/href="\/demo\/commit\/([0-9a-f]{64})"/);
    expect(m).not.toBeNull();
    const res = await fetch(`${base}/demo/commit/${m![1]}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("update hello");
    expect(body).toContain("hello.txt");
  });

  test("browse shows the file tree and navigates directories", async () => {
    const res = await fetch(`${base}/demo/browse/main`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello.txt");
    expect(body).toContain("src/");
    expect(body).toContain("evil.txt");

    const nested = await fetch(`${base}/demo/browse/main/src`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toContain("nested.txt");
  });

  test("blob page returns content with line numbers", async () => {
    const res = await fetch(`${base}/demo/blob/main/hello.txt`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello javelin world");
    expect(body).toContain('class="ln"');
    expect(body).toContain(">2<");
  });

  test("search returns a hit for a known string", async () => {
    const res = await fetch(`${base}/demo/search?q=nested+content`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("src/nested.txt");
    expect(body).toContain("nested content alpha");
  });

  test("unknown repo returns 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    const nested = await fetch(`${base}/demo/browse/main/missing.txt`);
    expect(nested.status).toBe(404);
  });

  test("html output is escaped", async () => {
    const res = await fetch(`${base}/demo/blob/main/evil.txt`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});
