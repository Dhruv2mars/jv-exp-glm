import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectId, WireObject } from "@javelin/protocol";
import { encodeBase64, JRP_VERSION_HEADER } from "@javelin/protocol";
import { Repository } from "@javelin/vcs";
import { createServer, type JavelindServer } from "./server";

const encoder = new TextEncoder();

interface TestServer {
  server: JavelindServer;
  root: string;
  url: string;
  token?: string;
}

async function startServer(opts?: { token?: string; root?: string }): Promise<TestServer> {
  const root = opts?.root ?? (await mkdtemp(join(tmpdir(), "javelind-test-")));
  const server = createServer({ port: 0, root, token: opts?.token });
  return { server, root, url: `http://localhost:${server.port}`, token: opts?.token };
}

interface RequestOptions {
  body?: unknown;
  token?: string | null;
  version?: string | null;
  headers?: Record<string, string>;
}

async function call(t: TestServer, method: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  const version = options.version === undefined ? "2" : options.version;
  if (version !== null) headers[JRP_VERSION_HEADER] = version;
  const token = options.token === undefined ? t.token : options.token;
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (options.body instanceof Uint8Array) {
    init.body = options.body as unknown as BodyInit;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  return fetch(`${t.url}${path}`, init);
}

async function jsonError(res: Response): Promise<{ code: string; message: string; supported?: number[] }> {
  const body = (await res.json()) as { error: { code: string; message: string; supported?: number[] } };
  return body.error;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Chain {
  objects: WireObject[];
  ids: ObjectId[];
  head: ObjectId;
}

/** Builds a real v2 state chain with a client-side repository, ready for batch-upload. */
async function buildChain(steps: number, fileFor?: (step: number) => Record<string, Uint8Array | string>): Promise<Chain> {
  const dir = await mkdtemp(join(tmpdir(), "javelind-client-"));
  const repo = await Repository.init(dir);
  await repo.layerNew("agent-x");
  const ids: ObjectId[] = [];
  for (let i = 0; i < steps; i++) {
    for (const [path, content] of Object.entries(fileFor?.(i) ?? {})) {
      await Bun.write(join(dir, path), content);
    }
    const { stateId } = await repo.checkpoint({
      message: `checkpoint ${i}`,
      author: { name: "a", email: "a@x" },
      layer: "agent-x",
    });
    ids.push(stateId);
  }
  const objects: WireObject[] = [];
  for (const id of await repo.objects.list()) {
    const obj = await repo.objects.read(id);
    if (!obj) continue;
    objects.push(
      obj.kind === "blob" ? { id, kind: "blob", data: encodeBase64(obj.data) } : ({ id, kind: obj.kind, object: obj } as WireObject),
    );
  }
  await rm(dir, { recursive: true, force: true });
  return { objects, ids, head: ids[ids.length - 1]! };
}

async function createRepo(t: TestServer, name: string): Promise<void> {
  const res = await call(t, "POST", "/jrp/v2/repos", { body: { name } });
  expect(res.status).toBe(200);
}

const servers: TestServer[] = [];
afterAll(async () => {
  for (const t of servers) t.server.stop();
});

describe("javelind JRP v2", () => {
  test("version negotiation, auth, and error envelope", async () => {
    const t = await startServer({ token: "sekret" });
    servers.push(t);

    const noVersion = await call(t, "GET", "/jrp/v2/repos", { version: null });
    expect(noVersion.status).toBe(409);
    expect(await jsonError(noVersion)).toEqual({
      code: "version_not_supported",
      message: "unsupported JRP version",
      supported: [2],
    });

    const v1 = await call(t, "GET", "/jrp/v2/repos", { version: "1" });
    expect(v1.status).toBe(409);

    const unauth = await call(t, "GET", "/jrp/v2/repos", { token: null });
    expect(unauth.status).toBe(401);
    expect((await jsonError(unauth)).code).toBe("unauthorized");

    const wrongToken = await call(t, "GET", "/jrp/v2/repos", { token: "wrong" });
    expect(wrongToken.status).toBe(401);

    const ok = await call(t, "GET", "/jrp/v2/repos");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ repos: [] });

    const health = await call(t, "GET", "/jrp/v2/healthz", { token: null, version: null });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });

  test("repos: create, duplicate, list pagination, readyz", async () => {
    const t = await startServer();
    servers.push(t);

    const created = await call(t, "POST", "/jrp/v2/repos", { body: { name: "demo", description: "first repo" } });
    expect(created.status).toBe(200);
    const repo = (await created.json()) as { repo: { name: string; description?: string; createdAt: string } };
    expect(repo.repo.name).toBe("demo");
    expect(repo.repo.description).toBe("first repo");
    expect(repo.repo.createdAt).toBeTruthy();

    expect((await call(t, "POST", "/jrp/v2/repos", { body: { name: "demo" } })).status).toBe(409);
    expect((await call(t, "POST", "/jrp/v2/repos", { body: { name: "../evil" } })).status).toBe(400);

    for (const name of ["alpha", "beta", "gamma"]) await createRepo(t, name);
    const page1 = await call(t, "GET", "/jrp/v2/repos?limit=2");
    const page1Body = (await page1.json()) as { repos: { name: string }[]; nextCursor?: string };
    expect(page1Body.repos.map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(page1Body.nextCursor).toBeTruthy();
    const page2 = await call(t, "GET", `/jrp/v2/repos?limit=2&cursor=${encodeURIComponent(page1Body.nextCursor!)}`);
    const page2Body = (await page2.json()) as { repos: { name: string }[]; nextCursor?: string };
    expect(page2Body.repos.map((r) => r.name)).toEqual(["demo", "gamma"]);
    expect(page2Body.nextCursor).toBeUndefined();

    const ready = await call(t, "GET", "/jrp/v2/readyz", { version: null, token: null });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true, checks: { objects: true, meta: true } });
  });

  test("heads view and per-key CAS updates", async () => {
    const t = await startServer();
    servers.push(t);
    await createRepo(t, "heads");
    const chain = await buildChain(2);

    const heads1 = (await (await call(t, "GET", "/jrp/v2/repos/heads/heads")).json()) as {
      world: string | null;
      layers: { name: string; base: string; head: string | null }[];
    };
    expect(heads1.world).toMatch(/^[0-9a-f]{64}$/);
    expect(heads1.layers).toEqual([]);
    const initWorld = heads1.world!;

    const createLayer = await call(t, "POST", "/jrp/v2/repos/heads/heads/update", {
      body: { updates: [{ key: "layer/agent-x", expected: null, next: chain.head }] },
    });
    expect(((await createLayer.json()) as { results: { ok: boolean }[] }).results[0]!.ok).toBe(true);

    const worldMove = await call(t, "POST", "/jrp/v2/repos/heads/heads/update", {
      body: { updates: [{ key: "world", expected: initWorld, next: chain.head }] },
    });
    const worldResult = (await worldMove.json()) as { results: { key: string; ok: boolean; reason?: string }[] };
    expect(worldResult.results[0]!.ok).toBe(true);

    const stale = await call(t, "POST", "/jrp/v2/repos/heads/heads/update", {
      body: { updates: [{ key: "world", expected: initWorld, next: chain.ids[0] }] },
    });
    const staleResult = (await stale.json()) as { results: { key: string; ok: boolean; reason?: string }[] };
    expect(staleResult.results[0]!.ok).toBe(false);
    expect(staleResult.results[0]!.reason).toBe("cas-mismatch");

    const unknownLayer = await call(t, "POST", "/jrp/v2/repos/heads/heads/update", {
      body: { updates: [{ key: "layer/ghost", expected: chain.head, next: null }] },
    });
    expect(((await unknownLayer.json()) as { results: { reason?: string }[] }).results[0]!.reason).toBe("not-found");

    const heads2 = (await (await call(t, "GET", "/jrp/v2/repos/heads/heads")).json()) as {
      world: string | null;
      layers: { name: string; head: string | null; base: string }[];
    };
    expect(heads2.world).toBe(chain.head);
    expect(heads2.layers).toHaveLength(1);
    expect(heads2.layers[0]!.name).toBe("agent-x");
    expect(heads2.layers[0]!.head).toBe(chain.head);
  });

  test("objects: batch-upload idempotent, batch-fetch with missing, oversize rejected", async () => {
    const t = await startServer();
    servers.push(t);
    await createRepo(t, "obj");
    const chain = await buildChain(2);

    const up = await call(t, "POST", "/jrp/v2/repos/obj/objects/batch-upload", { body: { objects: chain.objects } });
    expect(up.status).toBe(200);
    const upload = (await up.json()) as { accepted: string[]; rejected: { id: string; reason: string }[] };
    expect(upload.rejected).toEqual([]);
    expect(upload.accepted).toHaveLength(chain.objects.length);

    const again = await call(t, "POST", "/jrp/v2/repos/obj/objects/batch-upload", { body: { objects: chain.objects } });
    const reupload = (await again.json()) as { accepted: string[]; rejected: unknown[] };
    expect(reupload.accepted).toHaveLength(chain.objects.length);
    expect(reupload.rejected).toEqual([]);

    const tampered = [...chain.objects];
    tampered[0] = { ...(tampered[0] as WireObject), id: "a".repeat(64) as ObjectId };
    const bad = await call(t, "POST", "/jrp/v2/repos/obj/objects/batch-upload", { body: { objects: tampered } });
    const badUpload = (await bad.json()) as { accepted: unknown[]; rejected: { reason: string }[] };
    expect(badUpload.accepted).toHaveLength(chain.objects.length - 1);
    expect(badUpload.rejected[0]!.reason).toBe("id does not match content");

    const fetchRes = await call(t, "POST", "/jrp/v2/repos/obj/objects/batch-fetch", {
      body: { ids: [chain.head, "b".repeat(64)] },
    });
    const fetched = (await fetchRes.json()) as { objects: { id: string }[]; missing: string[] };
    expect(fetched.objects.map((o) => o.id)).toEqual([chain.head]);
    expect(fetched.missing).toEqual(["b".repeat(64)]);

    const invalid = await call(t, "POST", "/jrp/v2/repos/obj/objects/batch-fetch", { body: { ids: ["zzz"] } });
    expect(invalid.status).toBe(400);

    const big = new Uint8Array(25 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
    const oversize = await call(t, "POST", "/jrp/v2/repos/obj/objects/batch-upload", {
      body: { objects: [{ id: "0".repeat(64), kind: "blob", data: encodeBase64(big) }] },
    });
    expect(oversize.status).toBe(413);
    expect((await jsonError(oversize)).code).toBe("payload_too_large");
  });

  test("raw blobs: streamed PUT then GET returns identical bytes", async () => {
    const t = await startServer();
    servers.push(t);
    await createRepo(t, "raw");
    const bytes = new Uint8Array(4 * 1024 * 1024 + 1024 * 1024 + 13);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i % 7)) % 256;
    const id = (await sha256Hex(bytes)) as ObjectId;

    const put = await call(t, "PUT", `/jrp/v2/repos/raw/raw/${id}`, {
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(put.status, await put.text()).toBe(200);

    const mismatch = await call(t, "PUT", `/jrp/v2/repos/raw/raw/${id}`, {
      body: encoder.encode("not the bytes"),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(mismatch.status).toBe(400);
    expect((await jsonError(mismatch)).code).toBe("bad_request");

    const get = await call(t, "GET", `/jrp/v2/repos/raw/raw/${id}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    const roundTrip = new Uint8Array(await get.arrayBuffer());
    expect(roundTrip.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(roundTrip).equals(Buffer.from(bytes))).toBe(true);

    const missing = await call(t, "GET", `/jrp/v2/repos/raw/raw/${"c".repeat(64)}`);
    expect(missing.status).toBe(404);
    expect((await jsonError(missing)).code).toBe("not_found");
  });

  test("states/log walks parents newest first with pagination", async () => {
    const t = await startServer();
    servers.push(t);
    await createRepo(t, "log");
    const chain = await buildChain(3);
    await call(t, "POST", "/jrp/v2/repos/log/objects/batch-upload", { body: { objects: chain.objects } });
    const heads = (await (await call(t, "GET", "/jrp/v2/repos/log/heads")).json()) as { world: string };
    await call(t, "POST", "/jrp/v2/repos/log/heads/update", {
      body: { updates: [{ key: "world", expected: heads.world, next: chain.head }] },
    });

    const page1 = await call(t, "POST", "/jrp/v2/repos/log/states/log", { body: { start: chain.head, limit: 2 } });
    const log1 = (await page1.json()) as {
      entries: { id: string; message: string; author: { name: string } }[];
      nextCursor?: string;
    };
    expect(log1.entries.map((e) => e.id)).toEqual([chain.ids[2]!, chain.ids[1]!]);
    expect(log1.entries[0]!.message).toBe("checkpoint 2");
    expect(log1.entries[0]!.author.name).toBe("a");
    expect(log1.nextCursor).toBeTruthy();

    const page2 = await call(t, "POST", "/jrp/v2/repos/log/states/log", {
      body: { start: chain.head, cursor: log1.nextCursor, limit: 2 },
    });
    const log2 = (await page2.json()) as { entries: { id: string }[]; nextCursor?: string };
    expect(log2.entries.map((e) => e.id)).toEqual([chain.ids[0]!]);
    expect(log2.nextCursor).toBeUndefined();

    const unknown = await call(t, "POST", "/jrp/v2/repos/log/states/log", { body: { start: "d".repeat(64) } });
    expect(unknown.status).toBe(404);
  });

  test("contributions: create, list, status CAS with legal and illegal transitions", async () => {
    const t = await startServer();
    servers.push(t);
    await createRepo(t, "contrib");
    const chain = await buildChain(2);
    await call(t, "POST", "/jrp/v2/repos/contrib/objects/batch-upload", { body: { objects: chain.objects } });
    const heads = (await (await call(t, "GET", "/jrp/v2/repos/contrib/heads")).json()) as { world: string };
    const base = heads.world;

    const makeContribution = (state: ObjectId) => ({
      kind: "contribution" as const,
      layer: "agent-x",
      state,
      base,
      title: "Fix bug",
      author: { name: "a", email: "a@x", time: new Date().toISOString() },
      createdAt: new Date().toISOString(),
    });

    const contribution = makeContribution(chain.head);
    const created = await call(t, "POST", "/jrp/v2/repos/contrib/contributions", {
      body: { contribution },
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: ObjectId };
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    const again = await call(t, "POST", "/jrp/v2/repos/contrib/contributions", {
      body: { contribution },
    });
    expect(((await again.json()) as { id: string }).id).toBe(id);

    const list = await call(t, "GET", "/jrp/v2/repos/contrib/contributions?status=open");
    const listed = (await list.json()) as { contributions: { id: string; status: string; title: string }[] };
    expect(listed.contributions).toHaveLength(1);
    expect(listed.contributions[0]!.status).toBe("open");

    const publish = await call(t, "POST", `/jrp/v2/repos/contrib/contributions/${id}/status`, {
      body: { expected: "open", next: { status: "published", worldState: chain.head } },
    });
    const published = (await publish.json()) as { id?: string; ok: boolean; status?: string };
    expect(published).toEqual({ id, ok: true, status: "published" });

    const stale = await call(t, "POST", `/jrp/v2/repos/contrib/contributions/${id}/status`, {
      body: { expected: "open", next: { status: "published", worldState: chain.head } },
    });
    const staleBody = (await stale.json()) as { id?: string; ok: boolean; reason?: string };
    expect(staleBody).toEqual({ id, ok: false, reason: "cas-mismatch" });

    const illegal = await call(t, "POST", `/jrp/v2/repos/contrib/contributions/${id}/status`, {
      body: { expected: "published", next: { status: "discarded" } },
    });
    expect((await illegal.json()) as { id?: string; ok: boolean; reason?: string }).toEqual({
      id,
      ok: false,
      reason: "illegal-transition",
    });

    const missing = await call(t, "POST", `/jrp/v2/repos/contrib/contributions/${"e".repeat(64)}/status`, {
      body: { expected: "open", next: { status: "discarded" } },
    });
    expect((await missing.json()) as { id?: string; ok: boolean; reason?: string }).toEqual({
      id: "e".repeat(64),
      ok: false,
      reason: "not-found",
    });

    const badDiscard = await call(t, "POST", `/jrp/v2/repos/contrib/contributions/${id}/status`, {
      body: { expected: "published", next: { status: "discarded", worldState: chain.head } },
    });
    expect(badDiscard.status).toBe(400);

    const created2 = await call(t, "POST", "/jrp/v2/repos/contrib/contributions", {
      body: { contribution: makeContribution(chain.ids[0]!) },
    });
    const id2 = ((await created2.json()) as { id: string }).id;
    const discard = await call(t, "POST", `/jrp/v2/repos/contrib/contributions/${id2}/status`, {
      body: { expected: "open", next: { status: "discarded", note: "superseded" } },
    });
    expect(((await discard.json()) as { ok: boolean }).ok).toBe(true);
    const listAll = await call(t, "GET", "/jrp/v2/repos/contrib/contributions");
    const all = (await listAll.json()) as { contributions: { id: string; status: string }[] };
    expect(all.contributions.map((c) => c.status).sort()).toEqual(["discarded", "published"]);
  });

  test("provenance and evidence: idempotent ingest and queries", async () => {
    const t = await startServer();
    servers.push(t);
    await createRepo(t, "prov");
    const chain = await buildChain(1);
    await call(t, "POST", "/jrp/v2/repos/prov/objects/batch-upload", { body: { objects: chain.objects } });

    const record = {
      kind: "provenance" as const,
      states: [chain.head],
      agent: { name: "codex", adapter: "codex" as const },
      startedAt: "2026-09-09T00:00:00.000Z",
      summary: "implemented the parser",
    };
    const put = await call(t, "POST", "/jrp/v2/repos/prov/provenance", { body: { record } });
    expect(put.status).toBe(200);
    const { id } = (await put.json()) as { id: ObjectId };

    const repeat = await call(t, "POST", "/jrp/v2/repos/prov/provenance", { body: { record } });
    expect(((await repeat.json()) as { id: string }).id).toBe(id);

    const byState = await call(t, "POST", "/jrp/v2/repos/prov/provenance/query", { body: { states: [chain.head] } });
    const stateHits = (await byState.json()) as { records: { agent: { name: string } }[] };
    expect(stateHits.records).toHaveLength(1);
    expect(stateHits.records[0]!.agent.name).toBe("codex");

    const byAgent = await call(t, "POST", "/jrp/v2/repos/prov/provenance/query", { body: { agent: "codex" } });
    expect(((await byAgent.json()) as { records: unknown[] }).records).toHaveLength(1);

    const miss = await call(t, "POST", "/jrp/v2/repos/prov/provenance/query", { body: { agent: "claude" } });
    expect(((await miss.json()) as { records: unknown[] }).records).toEqual([]);

    const evidence = {
      kind: "evidence" as const,
      state: chain.head,
      rules: "ci@sha256:abc",
      checks: [{ check: "build", status: "pass" as const }],
      at: "2026-09-09T00:00:00.000Z",
    };
    const evPut = await call(t, "POST", "/jrp/v2/repos/prov/evidence", { body: { record: evidence } });
    expect(evPut.status).toBe(200);
    const evId = ((await evPut.json()) as { id: string }).id;
    expect(evId).toMatch(/^[0-9a-f]{64}$/);

    const evQuery = await call(t, "POST", "/jrp/v2/repos/prov/evidence/query", { body: { state: chain.head } });
    const evBody = (await evQuery.json()) as { records: { rules: string }[] };
    expect(evBody.records).toHaveLength(1);
    expect(evBody.records[0]!.rules).toBe("ci@sha256:abc");

    const evFiltered = await call(t, "POST", "/jrp/v2/repos/prov/evidence/query", {
      body: { state: chain.head, rules: "other" },
    });
    expect(((await evFiltered.json()) as { records: unknown[] }).records).toEqual([]);
  });

  test("search: code (binary-safe), history, provenance, unknown repo", async () => {
    const t = await startServer();
    servers.push(t);
    await createRepo(t, "search");
    const needleBytes = new Uint8Array([
      0x00, 0xff, 0x80, 0x0a, ...encoder.encode("alpha BINARYNEEDLE beta\n"), 0xfe,
    ]);
    const chain = await buildChain(2, (i): Record<string, Uint8Array | string> =>
      i === 0 ? { "src/parse.ts": "export function NEEDLE() { return 1; }\n" } : { "assets/data.bin": needleBytes },
    );
    await call(t, "POST", "/jrp/v2/repos/search/objects/batch-upload", { body: { objects: chain.objects } });
    const heads = (await (await call(t, "GET", "/jrp/v2/repos/search/heads")).json()) as { world: string };
    const moved = await call(t, "POST", "/jrp/v2/repos/search/heads/update", {
      body: { updates: [{ key: "world", expected: heads.world, next: chain.head }] },
    });
    expect(((await moved.json()) as { results: { ok: boolean }[] }).results[0]!.ok).toBe(true);

    const code = await call(t, "POST", "/jrp/v2/repos/search/search", { body: { query: "NEEDLE", kind: "code" } });
    const codeBody = (await code.json()) as { hits: { kind: string; blob: string; path: string; snippet: string }[] };
    expect(codeBody.hits.length).toBe(2);
    const codeHit = codeBody.hits.find((h) => h.path === "src/parse.ts")!;
    expect(codeHit.kind).toBe("code");
    expect(codeHit.snippet).toContain("NEEDLE");
    const binaryHit = codeBody.hits.find((h) => h.path === "assets/data.bin")!;
    expect(binaryHit.blob).toMatch(/^[0-9a-f]{64}$/);
    expect(binaryHit.snippet).toContain("BINARYNEEDLE");

    const history = await call(t, "POST", "/jrp/v2/repos/search/search", {
      body: { query: "checkpoint 0", kind: "history" },
    });
    const historyBody = (await history.json()) as { hits: { kind: string; state: string }[] };
    expect(historyBody.hits.length).toBeGreaterThan(0);
    expect(historyBody.hits[0]!.kind).toBe("history");
    expect(historyBody.hits[0]!.state).toBe(chain.ids[0]!);

    await call(t, "POST", "/jrp/v2/repos/search/provenance", {
      body: {
        record: {
          kind: "provenance",
          states: [chain.head],
          agent: { name: "codex", adapter: "codex" },
          startedAt: "2026-09-09T00:00:00.000Z",
          summary: "wrote the NEEDLE parser",
        },
      },
    });
    const prov = await call(t, "POST", "/jrp/v2/repos/search/search", { body: { query: "codex", kind: "provenance" } });
    const provBody = (await prov.json()) as { hits: { kind: string; record: string }[] };
    expect(provBody.hits).toHaveLength(1);
    expect(provBody.hits[0]!.kind).toBe("provenance");

    const unknown = await call(t, "POST", "/jrp/v2/repos/nope/search", { body: { query: "x", kind: "code" } });
    expect(unknown.status).toBe(404);
    expect((await jsonError(unknown)).code).toBe("not_found");

    const badKind = await call(t, "POST", "/jrp/v2/repos/search/search", { body: { query: "x", kind: "nope" } });
    expect(badKind.status).toBe(400);
  });

  test("state persists across a server restart on the same root", async () => {
    const root = await mkdtemp(join(tmpdir(), "javelind-restart-"));
    const t1 = await startServer({ root });
    await createRepo(t1, "keep");
    const chain = await buildChain(1);
    await call(t1, "POST", "/jrp/v2/repos/keep/objects/batch-upload", { body: { objects: chain.objects } });
    const heads1 = (await (await call(t1, "GET", "/jrp/v2/repos/keep/heads")).json()) as { world: string };
    await call(t1, "POST", "/jrp/v2/repos/keep/heads/update", {
      body: { updates: [{ key: "world", expected: heads1.world, next: chain.head }] },
    });
    t1.server.stop();

    const t2 = await startServer({ root });
    servers.push(t2);
    const repos = await call(t2, "GET", "/jrp/v2/repos");
    expect(((await repos.json()) as { repos: { name: string }[] }).repos.map((r) => r.name)).toContain("keep");

    const heads2 = (await (await call(t2, "GET", "/jrp/v2/repos/keep/heads")).json()) as { world: string };
    expect(heads2.world).toBe(chain.head);

    const fetched = await call(t2, "POST", "/jrp/v2/repos/keep/objects/batch-fetch", { body: { ids: [chain.head] } });
    expect(((await fetched.json()) as { missing: string[] }).missing).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
