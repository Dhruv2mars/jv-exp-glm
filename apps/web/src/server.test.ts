import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JavelinClient, type ObjectId } from "@javelin/sdk";
import { openRepository, type Repository } from "@javelin/vcs";
import { createServer, type JavelindServer } from "../../javelind/src/server";
import { createWebServer, type WebServer } from "./server";

const TOKEN = "web-sekret";
const REPO = "demo";
const GREETING = "hello-javelin-world";
const XSS = '<script>alert("xss")</script>';
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0x00, 0x7f]);

let root: string;
let javelind: JavelindServer;
let web: WebServer;
let client: JavelinClient;
let repo: Repository;

let worldAfterSeed: ObjectId;
let codexState: ObjectId;
let secondState: ObjectId;
let openContribution: ObjectId;
let scratchContribution: ObjectId;
let helloBlob: ObjectId;
let xssBlob: ObjectId;
let binaryBlob: ObjectId;

async function get(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://localhost:${web.port}${path}`);
  return { status: res.status, body: await res.text() };
}

async function post(path: string, form: Record<string, string> = {}): Promise<Response> {
  const body = new URLSearchParams(form);
  return fetch(`http://localhost:${web.port}${path}`, { method: "POST", body, redirect: "manual" });
}

async function blobAt(stateId: ObjectId, path: string): Promise<ObjectId> {
  const state = await repo.loadState(stateId);
  let treeId = state.tree;
  const parts = path.split("/");
  for (const part of parts.slice(0, -1)) {
    const entry = (await repo.loadTree(treeId)).entries.find((e) => e.name === part);
    if (!entry) throw new Error(`no dir ${part} in ${path}`);
    treeId = entry.id;
  }
  const leaf = (await repo.loadTree(treeId)).entries.find((e) => e.name === parts[parts.length - 1]);
  if (!leaf) throw new Error(`no file ${path}`);
  return leaf.id;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "javelin-web-"));
  javelind = createServer({ port: 0, root, token: TOKEN });
  const javelindUrl = `http://localhost:${javelind.port}`;
  client = new JavelinClient({ baseUrl: javelindUrl, token: TOKEN });
  await client.createRepo({ name: REPO, description: "demo world" });
  repo = await openRepository(join(root, REPO));

  await repo.layerNew("codex-lane");
  await Bun.write(join(root, REPO, "src", "hello.ts"), `export const GREETING = "${GREETING}";\n`);
  await Bun.write(join(root, REPO, "notes", "xss.txt"), `${XSS}\nsecond line\n`);
  await Bun.write(join(root, REPO, "assets", "blob.bin"), BINARY);
  codexState = (
    await repo.checkpoint({ message: "add greeting and assets", author: { name: "codex", email: "codex@agents" }, layer: "codex-lane" })
  ).stateId;
  await repo.recordProvenance({
    states: [codexState],
    agent: { name: "codex", adapter: "codex" },
    model: "gpt-5-codex",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exit: "success",
    summary: "codex wrote the greeting",
  });
  const first = await repo.contribute("codex-lane", "Add greeting", { name: "codex", email: "codex@agents" });
  const published = await repo.publish(first, { name: "maintainer", email: "m@x" });
  if (!published.ok || !published.worldState) throw new Error(`seed publish failed: ${published.reason}`);
  worldAfterSeed = published.worldState;

  await repo.layerNew("human-lane");
  await Bun.write(join(root, REPO, "src", "second.ts"), "export const SECOND = 2;\n");
  secondState = (
    await repo.checkpoint({ message: "add second module", author: { name: "dhruv", email: "d@x" }, layer: "human-lane" })
  ).stateId;
  openContribution = await repo.contribute("human-lane", "Add second module", { name: "dhruv", email: "d@x" });

  await repo.layerNew("scratch");
  await Bun.write(join(root, REPO, "scratch.txt"), "throwaway\n");
  await repo.checkpoint({ message: "scratch work", author: { name: "dhruv", email: "d@x" }, layer: "scratch" });
  scratchContribution = await repo.contribute("scratch", "Scratch attempt", { name: "dhruv", email: "d@x" });

  helloBlob = await blobAt(worldAfterSeed, "src/hello.ts");
  xssBlob = await blobAt(worldAfterSeed, "notes/xss.txt");
  binaryBlob = await blobAt(worldAfterSeed, "assets/blob.bin");

  web = createWebServer({ javelindUrl, token: TOKEN, port: 0 });
});

afterAll(async () => {
  web?.stop();
  javelind?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("javelin web v2", () => {
  test("repo list shows the seeded repo and the create form works", async () => {
    const home = await get("/");
    expect(home.status).toBe(200);
    expect(home.body).toContain(`<a href="/${REPO}">${REPO}</a>`);
    expect(home.body).toContain("demo world");

    const created = await post("/-/repos", { name: "second", description: "another world" });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/second");
    expect((await get("/")).body).toContain(`<a href="/second">second</a>`);
  });

  test("overview shows world head, layers, and open contributions", async () => {
    const page = await get(`/${REPO}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(worldAfterSeed.slice(0, 8));
    expect(page.body).toContain(`/${REPO}/browse/world`);
    expect(page.body).toContain("codex-lane");
    expect(page.body).toContain("human-lane");
    expect(page.body).toContain("Open contributions (2)");
    expect(page.body).toContain("Add second module");
    expect(page.body).not.toContain("commit");
    expect(page.body).not.toContain("branch");
  });

  test("world log lists published state messages newest first", async () => {
    const page = await get(`/${REPO}/world`);
    expect(page.status).toBe(200);
    const publishAt = page.body.indexOf("publish codex-lane: Add greeting");
    const checkpointAt = page.body.indexOf("add greeting and assets");
    const initAt = page.body.indexOf(">init<");
    expect(publishAt).toBeGreaterThan(-1);
    expect(checkpointAt).toBeGreaterThan(publishAt);
    expect(initAt).toBeGreaterThan(checkpointAt);
  });

  test("state detail lists parents and files changed against the first parent", async () => {
    const page = await get(`/${REPO}/state/${worldAfterSeed}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("publish codex-lane: Add greeting");
    expect(page.body).toContain(`/${REPO}/state/${codexState}`);
    expect(page.body).toContain("Changed files vs first parent (3)");
    expect(page.body).toContain(`<a href="/${REPO}/blob/${helloBlob}/src/hello.ts">src/hello.ts</a>`);
    expect(page.body).toContain("notes/xss.txt");
    expect(page.body).toContain("assets/blob.bin");
  });

  test("layers page and layer log show the checkpoint chain", async () => {
    const layers = await get(`/${REPO}/layers`);
    expect(layers.status).toBe(200);
    expect(layers.body).toContain(`/${REPO}/layer/codex-lane`);
    expect(layers.body).toContain(`/${REPO}/layer/human-lane`);

    const log = await get(`/${REPO}/layer/human-lane`);
    expect(log.status).toBe(200);
    expect(log.body).toContain("add second module");
    expect(log.body).toContain(`/${REPO}/state/${secondState}`);
  });

  test("browse world walks the tree and reaches blobs", async () => {
    const top = await get(`/${REPO}/browse/world`);
    expect(top.status).toBe(200);
    expect(top.body).toContain(`<a href="/${REPO}/browse/world/src">src/</a>`);
    expect(top.body).toContain(`<a href="/${REPO}/browse/world/notes">notes/</a>`);

    const src = await get(`/${REPO}/browse/world/src`);
    expect(src.status).toBe(200);
    expect(src.body).toContain(`<a href="/${REPO}/blob/${helloBlob}/src/hello.ts">hello.ts</a>`);

    const layer = await get(`/${REPO}/browse/layer/human-lane/src`);
    expect(layer.status).toBe(200);
    expect(layer.body).toContain("second.ts");
  });

  test("blob view numbers text lines and flags binary content with a raw link", async () => {
    const text = await get(`/${REPO}/blob/${helloBlob}/src/hello.ts`);
    expect(text.status).toBe(200);
    expect(text.body).toContain('<span class="ln">1</span>');
    expect(text.body).toContain(GREETING);

    const binary = await get(`/${REPO}/blob/${binaryBlob}/assets/blob.bin`);
    expect(binary.status).toBe(200);
    expect(binary.body).toContain(`binary content, ${BINARY.byteLength} bytes`);
    expect(binary.body).toContain(`<a href="/${REPO}/raw/${binaryBlob}">raw</a>`);
    expect(binary.body).not.toContain('<span class="ln">');

    const raw = await fetch(`http://localhost:${web.port}/${REPO}/raw/${binaryBlob}`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(BINARY);
  });

  test("contributions page lists every contribution with a status badge", async () => {
    const page = await get(`/${REPO}/contributions`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Add greeting");
    expect(page.body).toContain('<span class="badge published">published</span>');
    expect(page.body).toContain("Add second module");
    expect(page.body).toContain('<span class="badge open">open</span>');
    expect(page.body).toContain(`/${REPO}/contribution/${openContribution}`);
  });

  test("search finds code with path and snippet, and provenance by agent", async () => {
    const code = await get(`/${REPO}/search?q=${GREETING}&kind=code`);
    expect(code.status).toBe(200);
    expect(code.body).toContain(`<a href="/${REPO}/blob/${helloBlob}/src/hello.ts">src/hello.ts</a>`);
    expect(code.body).toContain(GREETING);

    const provenance = await get(`/${REPO}/search?q=codex&kind=provenance`);
    expect(provenance.status).toBe(200);
    expect(provenance.body).toContain("codex wrote the greeting");
    expect(provenance.body).toContain("provenance");

    const history = await get(`/${REPO}/search?q=greeting&kind=history`);
    expect(history.status).toBe(200);
    expect(history.body).toContain(`/${REPO}/state/${codexState}`);
  });

  test("unknown repo, state, layer, and path return 404 pages", async () => {
    expect((await get("/nope")).status).toBe(404);
    expect((await get(`/${REPO}/state/${"0".repeat(64)}`)).status).toBe(404);
    expect((await get(`/${REPO}/state/not-an-id`)).status).toBe(404);
    expect((await get(`/${REPO}/layer/nope`)).status).toBe(404);
    expect((await get(`/${REPO}/browse/world/nope`)).status).toBe(404);
    expect((await get(`/${REPO}/browse/tag/x`)).status).toBe(404);
    expect((await get(`/${REPO}/contribution/${"0".repeat(64)}`)).status).toBe(404);
    const missing = await get("/nope");
    expect(missing.body).toContain("404");
  });

  test("file content containing <script> is escaped wherever it renders", async () => {
    const blob = await get(`/${REPO}/blob/${xssBlob}/notes/xss.txt`);
    expect(blob.status).toBe(200);
    expect(blob.body).not.toContain("<script>");
    expect(blob.body).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");

    const search = await get(`/${REPO}/search?q=alert&kind=code`);
    expect(search.status).toBe(200);
    expect(search.body).not.toContain("<script>");
    expect(search.body).toContain("&lt;script&gt;");
  });

  test("publishing an open contribution advances the world head", async () => {
    const before = await client.getHeads(REPO);
    expect(before.world).toBe(worldAfterSeed);

    const res = await post(`/${REPO}/contribution/${openContribution}/publish`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${REPO}/contribution/${openContribution}`);

    const after = await client.getHeads(REPO);
    expect(after.world).not.toBe(worldAfterSeed);
    const merged = await repo.loadState(after.world!);
    expect(merged.parents).toEqual([worldAfterSeed, secondState]);
    expect(merged.message).toBe("publish human-lane: Add second module");

    const detail = await get(`/${REPO}/contribution/${openContribution}`);
    expect(detail.body).toContain('<span class="badge published">published</span>');
    expect(detail.body).not.toContain("Publish to World");

    const overview = await get(`/${REPO}`);
    expect(overview.body).toContain(after.world!.slice(0, 8));
    expect(overview.body).toContain("Open contributions (1)");

    const state = await get(`/${REPO}/state/${after.world}`);
    expect(state.body).toContain("Changed files vs first parent (1)");
    expect(state.body).toContain("src/second.ts");

    const again = await post(`/${REPO}/contribution/${openContribution}/publish`);
    expect(again.status).toBe(409);
    expect((await client.getHeads(REPO)).world).toBe(after.world);
  });

  test("discarding an open contribution leaves the world untouched", async () => {
    const before = await client.getHeads(REPO);
    const res = await post(`/${REPO}/contribution/${scratchContribution}/discard`);
    expect(res.status).toBe(303);
    expect((await client.getHeads(REPO)).world).toBe(before.world);

    const detail = await get(`/${REPO}/contribution/${scratchContribution}`);
    expect(detail.body).toContain('<span class="badge discarded">discarded</span>');
    expect(detail.body).not.toContain("Discard</button>");

    const again = await post(`/${REPO}/contribution/${scratchContribution}/discard`);
    expect(again.status).toBe(409);
  });
});
