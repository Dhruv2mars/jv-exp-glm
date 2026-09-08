import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectId, type SerializedObject, type UpdateRefsResponse, type UploadObjectsResponse } from "@javelin/protocol";
import { Repository, type StoredObject } from "@javelin/vcs";
import { createServer, type JavelindServer } from "./server";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TestServer {
  server: JavelindServer;
  root: string;
  url: string;
}

async function startServer(opts?: { token?: string; root?: string }): Promise<TestServer> {
  const root = opts?.root ?? (await mkdtemp(join(tmpdir(), "javelind-test-")));
  const server = createServer({ port: 0, root, token: opts?.token });
  return { server, root, url: `http://localhost:${server.port}` };
}

async function request(base: string, method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function buildClientRepo(commits: number): Promise<{ repo: Repository; objects: SerializedObject[]; ids: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "javelind-client-"));
  const repo = await Repository.open(dir);
  const ids: string[] = [];
  for (let i = 0; i < commits; i++) {
    await repo.stage(`f${i}.txt`, encoder.encode(`content ${i}`));
    ids.push((await repo.commit({ message: `commit ${i}` })).toString());
  }
  const objects: SerializedObject[] = [];
  for (const id of await repo.objects.list()) {
    const obj = await repo.objects.read(id);
    if (!obj) continue;
    objects.push(
      obj.kind === "blob"
        ? { id, kind: "blob", data: decoder.decode((obj as Extract<StoredObject, { kind: "blob" }>).data) }
        : ({ id, kind: obj.kind, object: obj } as SerializedObject),
    );
  }
  return { repo, objects, ids };
}

async function stopAll(servers: TestServer[]): Promise<void> {
  for (const t of servers) t.server.stop();
}

describe("javelind", () => {
  const servers: TestServer[] = [];

  afterAll(async () => {
    await stopAll(servers);
  });

  test("full flow: create, upload, refs, fetch, log", async () => {
    const t = await startServer();
    servers.push(t);
    const { objects, ids } = await buildClientRepo(2);
    const c1 = ids[0]!;
    const c2 = ids[1]!;

    const created = await request(t.url, "POST", "/jrp/v1/repos", { name: "demo", defaultBranch: "main", description: "test" });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { name: string }).name).toBe("demo");

    const dup = await request(t.url, "POST", "/jrp/v1/repos", { name: "demo" });
    expect(dup.status).toBe(409);

    const bad = await request(t.url, "POST", "/jrp/v1/repos", { name: "../evil" });
    expect(bad.status).toBe(400);

    const up = await request(t.url, "POST", "/jrp/v1/repos/demo/objects/upload", { objects });
    expect(up.status).toBe(200);
    const upload = (await up.json()) as UploadObjectsResponse;
    expect(upload.rejected).toEqual([]);
    expect(upload.accepted).toHaveLength(objects.length);

    const tampered = [...objects];
    tampered[0] = { ...tampered[0]!, id: "a".repeat(64) as SerializedObject["id"] };
    const up2 = await request(t.url, "POST", "/jrp/v1/repos/demo/objects/upload", { objects: tampered });
    const upload2 = (await up2.json()) as UploadObjectsResponse;
    expect(upload2.accepted).toHaveLength(objects.length - 1);
    expect(upload2.rejected).toHaveLength(1);
    expect(upload2.rejected[0]!.reason).toContain("hash mismatch");

    const refsUpdate = await request(t.url, "POST", "/jrp/v1/repos/demo/refs/update", {
      updates: [{ ref: "refs/heads/main", expectedOld: null, new: c2 }],
    });
    expect(refsUpdate.status).toBe(200);
    const refRes = (await refsUpdate.json()) as UpdateRefsResponse;
    expect(refRes.results[0]!.ok).toBe(true);

    const refs = await request(t.url, "GET", "/jrp/v1/repos/demo/refs");
    const refsBody = (await refs.json()) as { refs: Record<string, string> };
    expect(refsBody.refs["refs/heads/main"]).toBe(c2);

    const fetched = await request(t.url, "POST", "/jrp/v1/repos/demo/objects/fetch", {
      want: [...ids, "b".repeat(64)],
    });
    const fetchBody = (await fetched.json()) as { objects: SerializedObject[] };
    expect(fetchBody.objects.map((o) => String(o.id)).sort()).toEqual([...ids].sort());

    const log = await request(t.url, "POST", "/jrp/v1/repos/demo/log", { start: "refs/heads/main", limit: 10 });
    const logBody = (await log.json()) as { commits: { id: string; message: string }[] };
    expect(logBody.commits.map((c) => c.id)).toEqual([c2, c1]);
    expect(logBody.commits[0]!.message).toBe("commit 1");

    const search = await request(t.url, "POST", "/jrp/v1/repos/demo/search", { query: "zzz" });
    expect(await search.json()).toEqual({ hits: [] });
  });

  test("search: code hits indexed files, history finds commit messages, unknown repo 404", async () => {
    const t = await startServer();
    servers.push(t);
    const { objects, ids } = await buildClientRepo(2);
    const c2 = ids[1]!;
    await request(t.url, "POST", "/jrp/v1/repos", { name: "s1" });
    await request(t.url, "POST", "/jrp/v1/repos/s1/objects/upload", { objects });
    const refsUpdate = await request(t.url, "POST", "/jrp/v1/repos/s1/refs/update", {
      updates: [{ ref: "refs/heads/main", expectedOld: null, new: c2 }],
    });
    expect(((await refsUpdate.json()) as UpdateRefsResponse).results[0]!.ok).toBe(true);

    const code = await request(t.url, "POST", "/jrp/v1/repos/s1/search", { query: "content 1" });
    expect(code.status).toBe(200);
    const codeBody = (await code.json()) as { hits: { kind: string; path?: string; commit?: string }[] };
    expect(codeBody.hits.length).toBeGreaterThan(0);
    expect(codeBody.hits[0]!.path).toBe("f1.txt");
    expect(codeBody.hits[0]!.commit).toBe(c2);

    const byCommit = await request(t.url, "POST", "/jrp/v1/repos/s1/search", { query: "content 0", commitId: c2 });
    const byCommitBody = (await byCommit.json()) as { hits: { path?: string; commit?: string }[] };
    expect(byCommitBody.hits[0]!.path).toBe("f0.txt");
    expect(byCommitBody.hits[0]!.commit).toBe(c2);

    const history = await request(t.url, "POST", "/jrp/v1/repos/s1/search", { query: "commit 0", kind: "history" });
    const historyBody = (await history.json()) as { hits: { kind: string; commit?: string }[] };
    expect(historyBody.hits[0]!.kind).toBe("history");
    expect(historyBody.hits[0]!.commit).toBe(ids[0]);

    const badKind = await request(t.url, "POST", "/jrp/v1/repos/s1/search", { query: "x", kind: "nope" });
    expect(badKind.status).toBe(400);

    const missing = await request(t.url, "POST", "/jrp/v1/repos/s1/search", { query: "content 1", commitId: "b".repeat(64) });
    expect(await missing.json()).toEqual({ hits: [] });

    const unknown = await request(t.url, "POST", "/jrp/v1/repos/nope/search", { query: "content 1" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("cas-mismatch and non-fast-forward rejection", async () => {
    const t = await startServer();
    servers.push(t);
    const { objects, ids } = await buildClientRepo(3);
    const [c1, c2, c3] = ids as [string, string, string];
    await request(t.url, "POST", "/jrp/v1/repos", { name: "r1" });
    await request(t.url, "POST", "/jrp/v1/repos/r1/objects/upload", { objects });
    await request(t.url, "POST", "/jrp/v1/repos/r1/refs/update", {
      updates: [{ ref: "refs/heads/main", expectedOld: null, new: c2 }],
    });

    const stale = await request(t.url, "POST", "/jrp/v1/repos/r1/refs/update", {
      updates: [{ ref: "refs/heads/main", expectedOld: c1, new: c3 }],
    });
    const staleRes = (await stale.json()) as UpdateRefsResponse;
    expect(staleRes.results[0]!.ok).toBe(false);
    expect(staleRes.results[0]!.reason).toBe("cas-mismatch");

    await request(t.url, "POST", "/jrp/v1/repos/r1/objects/upload", { objects: [] });
    const unrelatedRepo = await Repository.open(await mkdtemp(join(tmpdir(), "javelind-client-")));
    await unrelatedRepo.stage("x.txt", encoder.encode("unrelated"));
    const orphan = (await unrelatedRepo.commit({ message: "orphan", parents: [] })).toString();
    await request(t.url, "POST", "/jrp/v1/repos/r1/objects/upload", {
      objects: [{ id: objectId(orphan), kind: "commit", object: await unrelatedRepo.loadCommit(objectId(orphan)) }],
    });
    const nonFF = await request(t.url, "POST", "/jrp/v1/repos/r1/refs/update", {
      updates: [{ ref: "refs/heads/main", expectedOld: c2, new: orphan }],
    });
    const nonFFRes = (await nonFF.json()) as UpdateRefsResponse;
    expect(nonFFRes.results[0]!.ok).toBe(false);
    expect(nonFFRes.results[0]!.reason).toBe("non-fast-forward");
  });

  test("404 unknown repo", async () => {
    const t = await startServer();
    servers.push(t);
    const res = await request(t.url, "GET", "/jrp/v1/repos/nope/refs");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("401 when auth enabled and token missing or wrong", async () => {
    const t = await startServer({ token: "sekret" });
    servers.push(t);
    expect((await request(t.url, "GET", "/jrp/v1/repos")).status).toBe(401);
    expect((await request(t.url, "GET", "/jrp/v1/repos", undefined, "wrong")).status).toBe(401);
    const ok = await request(t.url, "GET", "/jrp/v1/repos", undefined, "sekret");
    expect(ok.status).toBe(200);
  });

  test("persistence across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "javelind-restart-"));
    const t1 = await startServer({ root });
    await request(t1.url, "POST", "/jrp/v1/repos", { name: "keep" });
    const { objects, ids } = await buildClientRepo(1);
    await request(t1.url, "POST", "/jrp/v1/repos/keep/objects/upload", { objects });
    await request(t1.url, "POST", "/jrp/v1/repos/keep/refs/update", {
      updates: [{ ref: "refs/heads/main", expectedOld: null, new: ids[0] }],
    });
    t1.server.stop();

    const t2 = await startServer({ root });
    servers.push(t2);
    const repos = await request(t2.url, "GET", "/jrp/v1/repos");
    const reposBody = (await repos.json()) as { repos: { name: string }[] };
    expect(reposBody.repos.map((r) => r.name)).toContain("keep");
    const refs = await request(t2.url, "GET", "/jrp/v1/repos/keep/refs");
    const refsBody = (await refs.json()) as { refs: Record<string, string> };
    expect(refsBody.refs["refs/heads/main"]).toBe(ids[0]);
    await rm(root, { recursive: true, force: true });
  });

  test("20 parallel CAS updates: exactly one winner", async () => {
    const t = await startServer();
    servers.push(t);
    const { objects, ids } = await buildClientRepo(20);
    await request(t.url, "POST", "/jrp/v1/repos", { name: "race" });
    const upload = await request(t.url, "POST", "/jrp/v1/repos/race/objects/upload", { objects });
    expect(((await upload.json()) as UploadObjectsResponse).rejected).toEqual([]);
    const responses = await Promise.all(
      ids.map((id) =>
        request(t.url, "POST", "/jrp/v1/repos/race/refs/update", {
          updates: [{ ref: "refs/heads/main", expectedOld: null, new: id }],
        }).then((r) => r.json() as Promise<UpdateRefsResponse>),
      ),
    );
    const results = responses.flatMap((r) => r.results);
    expect(results).toHaveLength(20);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.every((r) => r.ok || r.reason === "cas-mismatch")).toBe(true);
  });
});
