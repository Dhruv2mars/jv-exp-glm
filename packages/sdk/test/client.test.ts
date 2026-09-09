import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CONTRIBUTION_TRANSITIONS,
  DEFAULT_PAGE,
  JavelinClient,
  LimitExceededError,
  MAX_BATCH_BYTES,
  MAX_OBJECT_BYTES,
  JrpError,
  JrpProtocolError,
  cursor,
  decodeBase64,
  objectId,
  routes,
  type Contribution,
  type EvidenceRecord,
  type HeadUpdate,
  type ObjectId,
  type ProvenanceRecord,
  type SearchResult,
  type StateLogEntry,
  type WireObject,
} from "../src";

type State = Extract<WireObject, { kind: "state" }>["object"];

const NOW = "2026-09-09T00:00:00.000Z";
const sha = (n: number) => objectId(n.toString(16).padStart(64, "0"));
const token = "tok";
const layerName = "agent-x";
const layerBase = sha(2);
const stateIds = [sha(10), sha(11), sha(12)] as const;

const stateOf = (id: ObjectId, parents: ObjectId[], message: string): State => ({
  kind: "state",
  tree: sha(3),
  parents,
  author: { name: "a", email: "a@x", time: NOW },
  message,
});

function contentBlob(content: string): WireObject {
  const bytes = new TextEncoder().encode(content);
  return { id: objectId(sha256(bytes)), kind: "blob", data: Buffer.from(content).toString("base64") };
}

const db = {
  repos: [{ name: "demo", createdAt: NOW }],
  objects: new Map<ObjectId, WireObject>([[contentBlob("hello").id, contentBlob("hello")]]),
  heads: { world: null as ObjectId | null, layers: new Map<string, ObjectId | null>([[layerName, sha(20)]]) },
  raw: new Map<ObjectId, Uint8Array<ArrayBuffer>>(),
  states: new Map<ObjectId, State>([
    [stateIds[0], stateOf(stateIds[0], [], "init")],
    [stateIds[1], stateOf(stateIds[1], [stateIds[0]], "feat: parse")],
    [stateIds[2], stateOf(stateIds[2], [stateIds[1]], "fix: walker")],
  ]),
  provenance: [] as { id: ObjectId; record: ProvenanceRecord }[],
  evidence: [] as { id: ObjectId; record: EvidenceRecord }[],
  contributions: new Map<ObjectId, { contribution: Contribution; status: "open" | "published" | "discarded" }>(),
};

const searchHits: SearchResult[] = [
  { kind: "code", blob: sha(30), path: "src/parse.ts", snippet: "parse tree walker", score: 0.93 },
  { kind: "code", blob: sha(31), path: "src/parser.ts", snippet: "parse tokens", score: 0.81 },
  { kind: "history", state: stateIds[2], snippet: "feat: parse tree", score: 0.7 },
  { kind: "provenance", record: sha(40), snippet: "codex run", score: 0.6 },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function err(code: string, message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ error: { code, message, ...extra } }, status);
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function hashJson(value: unknown): ObjectId {
  return objectId(sha256(new TextEncoder().encode(JSON.stringify(value))));
}

const captured: { method: string; url: string; headers: Headers }[] = [];
let lastBody: unknown;

async function jsonBody(req: Request): Promise<unknown> {
  lastBody = (await req.json()) as unknown;
  return lastBody;
}

function page<T>(items: T[], rawCursor: string | null, rawLimit: number | null) {
  const limit = Math.min(rawLimit ?? DEFAULT_PAGE, 1000);
  const offset = rawCursor === null ? 0 : Number(atob(rawCursor));
  const slice = items.slice(offset, offset + limit);
  return { slice, nextCursor: offset + limit < items.length ? cursor(btoa(String(offset + limit))) : undefined };
}

type Handler = (m: RegExpMatchArray, req: Request) => Response | Promise<Response>;

function capture(m: RegExpMatchArray, i: number): string {
  const group = m[i];
  if (group === undefined) throw new Error(`missing capture group ${i}`);
  return group;
}

const table: { method: string; re: RegExp; handle: Handler }[] = [
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos$/,
    handle: async (_m, req) => {
      const { name } = (await jsonBody(req)) as { name: string };
      if (db.repos.some((r) => r.name === name)) return err("conflict", `repo ${name} exists`, 409);
      const repo = { name, createdAt: NOW };
      db.repos.push(repo);
      return json({ repo });
    },
  },
  {
    method: "GET",
    re: /^\/jrp\/v2\/repos$/,
    handle: (_m, req) => {
      const { slice, nextCursor } = page(db.repos, new URL(req.url).searchParams.get("cursor"), null);
      return json({ repos: slice, nextCursor });
    },
  },
  {
    method: "GET",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/heads$/,
    handle: () =>
      json({
        world: db.heads.world,
        layers: [...db.heads.layers].map(([name, head]) => ({ name, base: layerBase, head, updatedAt: NOW })),
      }),
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/heads\/update$/,
    handle: async (_m, req) => {
      const { updates } = (await jsonBody(req)) as { updates: HeadUpdate[] };
      const results = updates.map((u) => {
        const current = u.key === "world" ? db.heads.world : (db.heads.layers.get(u.key.slice("layer/".length)) ?? null);
        if (current !== u.expected) {
          return { key: u.key, ok: false, reason: current === null ? ("not-found" as const) : ("cas-mismatch" as const) };
        }
        if (u.key === "world") db.heads.world = u.next;
        else db.heads.layers.set(u.key.slice("layer/".length), u.next);
        return { key: u.key, ok: true };
      });
      return json({ results });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/objects\/batch-fetch$/,
    handle: async (_m, req) => {
      const { ids } = (await jsonBody(req)) as { ids: ObjectId[] };
      return json({
        objects: ids.filter((id) => db.objects.has(id)).map((id) => db.objects.get(id)),
        missing: ids.filter((id) => !db.objects.has(id)),
      });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/objects\/batch-upload$/,
    handle: async (_m, req) => {
      const { objects } = (await jsonBody(req)) as { objects: WireObject[] };
      const accepted: ObjectId[] = [];
      const rejected: { id: ObjectId; reason: string }[] = [];
      for (const o of objects) {
        const content =
          o.kind === "blob" ? decodeBase64(o.data) : new TextEncoder().encode(JSON.stringify(o.object));
        if (sha256(content) !== o.id) rejected.push({ id: o.id, reason: "id does not match content" });
        else {
          accepted.push(o.id);
          db.objects.set(o.id, o);
        }
      }
      return json({ accepted, rejected });
    },
  },
  {
    method: "PUT",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/raw\/([0-9a-f]{64})$/,
    handle: async (m, req) => {
      const id = objectId(decodeURIComponent(capture(m, 2)));
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (sha256(bytes) !== id) return err("bad_request", "id does not match content", 400);
      db.raw.set(id, bytes);
      return new Response(null, { status: 200 });
    },
  },
  {
    method: "GET",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/raw\/([0-9a-f]{64})$/,
    handle: (m) => {
      const bytes = db.raw.get(objectId(decodeURIComponent(capture(m, 2))));
      if (bytes === undefined) return err("not_found", "no such raw object", 404);
      return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/states\/log$/,
    handle: async (_m, req) => {
      const body = (await jsonBody(req)) as { start: ObjectId; cursor?: string; limit?: number };
      if (!db.states.has(body.start)) return err("not_found", `no state ${body.start}`, 404);
      const entries: StateLogEntry[] = [];
      let id: ObjectId | undefined = body.start;
      while (id !== undefined) {
        const s = db.states.get(id);
        if (s === undefined) break;
        entries.push({ id, parents: s.parents, message: s.message, author: s.author });
        id = s.parents[0];
      }
      const { slice, nextCursor } = page(entries, body.cursor ?? null, body.limit ?? null);
      return json({ entries: slice, nextCursor });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/provenance$/,
    handle: async (_m, req) => {
      const { record } = (await jsonBody(req)) as { record: ProvenanceRecord };
      const id = hashJson(record);
      db.provenance.push({ id, record });
      return json({ id });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/provenance\/query$/,
    handle: async (_m, req) => {
      const q = (await jsonBody(req)) as { states?: ObjectId[]; agent?: string; cursor?: string };
      const matches = db.provenance
        .filter(
          ({ record }) =>
            (q.agent === undefined || record.agent.name === q.agent) &&
            (q.states === undefined || q.states.some((s) => record.states.includes(s))),
        )
        .map(({ record }) => record);
      const { slice, nextCursor } = page(matches, q.cursor ?? null, null);
      return json({ records: slice, nextCursor });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/evidence$/,
    handle: async (_m, req) => {
      const { record } = (await jsonBody(req)) as { record: EvidenceRecord };
      const id = hashJson(record);
      db.evidence.push({ id, record });
      return json({ id });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/evidence\/query$/,
    handle: async (_m, req) => {
      const q = (await jsonBody(req)) as { state: ObjectId; rules?: string };
      return json({
        records: db.evidence
          .filter(({ record }) => record.state === q.state && (q.rules === undefined || record.rules === q.rules))
          .map(({ record }) => record),
      });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/contributions$/,
    handle: async (_m, req) => {
      const { contribution } = (await jsonBody(req)) as { contribution: Contribution };
      const id = hashJson(contribution);
      db.contributions.set(id, { contribution, status: "open" });
      return json({ id });
    },
  },
  {
    method: "GET",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/contributions$/,
    handle: (_m, req) => {
      const url = new URL(req.url);
      const status = url.searchParams.get("status") ?? undefined;
      const matches = [...db.contributions]
        .filter(([, entry]) => status === undefined || entry.status === status)
        .map(([id, entry]) => ({ id, ...entry.contribution, status: entry.status }));
      const { slice, nextCursor } = page(matches, url.searchParams.get("cursor"), null);
      return json({ contributions: slice, nextCursor });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/contributions\/([0-9a-f]{64})\/status$/,
    handle: async (m, req) => {
      const id = objectId(decodeURIComponent(capture(m, 2)));
      const { expected, next } = (await jsonBody(req)) as {
        expected: "open" | "published" | "discarded";
        next: { status: "open" | "published" | "discarded"; worldState?: ObjectId };
      };
      const entry = db.contributions.get(id);
      if (entry === undefined) return json({ id, ok: false, reason: "not-found" });
      if (entry.status !== expected) return json({ id, ok: false, reason: "cas-mismatch" });
      if (!CONTRIBUTION_TRANSITIONS[entry.status].includes(next.status)) {
        return json({ id, ok: false, reason: "illegal-transition" });
      }
      entry.status = next.status;
      return json({ id, ok: true, status: next.status });
    },
  },
  {
    method: "POST",
    re: /^\/jrp\/v2\/repos\/([^/]+)\/search$/,
    handle: async (_m, req) => {
      const body = (await jsonBody(req)) as { query: string; kind: string; cursor?: string; limit?: number };
      const matches = searchHits.filter(
        (h) =>
          h.kind === body.kind &&
          (h.snippet.includes(body.query) || ("path" in h && h.path.includes(body.query))),
      );
      const { slice, nextCursor } = page(matches, body.cursor ?? null, body.limit ?? null);
      return json({ hits: slice, nextCursor });
    },
  },
];

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  captured.push({ method: req.method, url: url.pathname + url.search, headers: req.headers });

  if (url.pathname === routes.healthz) return json({ ok: true });
  if (url.pathname === routes.readyz) return json({ ok: true, checks: { store: true, search: true } });

  if (req.headers.get("authorization") !== `Bearer ${token}`) return err("unauthorized", "bad token", 401);
  if (req.headers.get("x-jrp-version") !== "2") {
    return err("version_not_supported", "unsupported JRP version", 409, { supported: [2] });
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BATCH_BYTES && !url.pathname.includes("/raw/")) {
    return err("payload_too_large", "request body exceeds MAX_BATCH_BYTES", 413);
  }

  for (const route of table) {
    const m = route.re.exec(url.pathname);
    if (m !== null && route.method === req.method) return route.handle(m, req);
  }
  return err("not_found", `no route ${req.method} ${url.pathname}`, 404);
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: handle });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

const client = () => new JavelinClient({ baseUrl, token });

const demoContribution: Contribution = {
  kind: "contribution",
  layer: layerName,
  state: stateIds[2],
  base: sha(1),
  title: "Fix parse",
  author: { name: "a", email: "a@x", time: NOW },
  createdAt: NOW,
};

describe("JavelinClient over real Bun.serve (JRP v2)", () => {
  test("health and ready skip auth and version, parse their envelopes", async () => {
    expect(await new JavelinClient({ baseUrl }).health()).toBe(true);
    expect(await new JavelinClient({ baseUrl }).ready()).toEqual({ ok: true, checks: { store: true, search: true } });
  });

  test("data requests carry x-jrp-version 2 and bearer auth", async () => {
    await client().listRepos();
    const r = captured.at(-1);
    expect(r?.headers.get("x-jrp-version")).toBe("2");
    expect(r?.headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  test("createRepo posts the body and unwraps the repo envelope", async () => {
    const repo = await client().createRepo({ name: "second", description: "d" });
    expect(repo).toEqual({ name: "second", createdAt: NOW });
    expect(captured.at(-1)?.url).toBe(routes.repos);
    expect(lastBody).toEqual({ name: "second", description: "d" });
  });

  test("duplicate repo name surfaces 409 conflict", async () => {
    const e = await client().createRepo({ name: "demo" }).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(JrpError);
    expect((e as JrpError).code).toBe("conflict");
    expect((e as JrpError).status).toBe(409);
  });

  test("listRepos paginates with opaque cursors", async () => {
    for (let i = 0; i < DEFAULT_PAGE + 2; i++) db.repos.push({ name: `bulk-${i}`, createdAt: NOW });
    const page1 = await client().listRepos();
    expect(page1.repos).toHaveLength(DEFAULT_PAGE);
    expect(page1.nextCursor).toBeDefined();
    const r = captured.at(-1);
    expect(r?.url).toBe(routes.repos);
    const page2 = await client().listRepos(page1.nextCursor);
    expect(captured.at(-1)?.url).toBe(`${routes.repos}?cursor=${page1.nextCursor}`);
    expect(page2.repos).toHaveLength(db.repos.length - DEFAULT_PAGE);
    expect(page2.nextCursor).toBeUndefined();
  });

  test("getHeads returns world and layers", async () => {
    const heads = await client().getHeads("demo");
    expect(heads.world).toBeNull();
    expect(heads.layers).toEqual([{ name: layerName, base: layerBase, head: sha(20), updatedAt: NOW }]);
  });

  test("updateHeads applies CAS updates and reports per-key results", async () => {
    const results = await client().updateHeads("demo", [
      { key: "world", expected: null, next: stateIds[0] },
      { key: `layer/${layerName}`, expected: sha(20), next: stateIds[1] },
    ]);
    expect(lastBody).toEqual({
      updates: [
        { key: "world", expected: null, next: stateIds[0] },
        { key: `layer/${layerName}`, expected: sha(20), next: stateIds[1] },
      ],
    });
    expect(results).toEqual([{ key: "world", ok: true }, { key: `layer/${layerName}`, ok: true }]);
    expect((await client().getHeads("demo")).world).toBe(stateIds[0]);
  });

  test("updateHeads surfaces cas-mismatch without throwing", async () => {
    const results = await client().updateHeads("demo", [{ key: "world", expected: sha(9), next: stateIds[2] }]);
    expect(results).toEqual([{ key: "world", ok: false, reason: "cas-mismatch" }]);
  });

  test("batchFetch returns objects and missing ids", async () => {
    const hello = contentBlob("hello");
    const res = await client().batchFetch("demo", [hello.id, sha(61)]);
    expect(res.objects).toEqual([hello]);
    expect(res.missing).toEqual([sha(61)]);
    expect(lastBody).toEqual({ ids: [hello.id, sha(61)] });
  });

  test("batchUpload accepts content-addressed objects and rejects mismatched ids", async () => {
    const good = contentBlob("hello");
    const bad = { ...contentBlob("other"), id: sha(63) };
    const res = await client().batchUpload("demo", [good, bad]);
    expect(res.accepted).toEqual([good.id]);
    expect(res.rejected).toEqual([{ id: sha(63), reason: "id does not match content" }]);
  });

  test("putRawBlob and getRawBlob round-trip non-UTF8 bytes", async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x7f, 0x80, 0xfe, 0x0d, 0x0a, 0x00]);
    const id = objectId(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    await client().putRawBlob("demo", id, bytes);
    const putHeaders = captured.at(-1)?.headers;
    expect(putHeaders?.get("content-type")).toBe("application/octet-stream");
    expect(Number(putHeaders?.get("content-length"))).toBe(bytes.byteLength);
    const round = await client().getRawBlob("demo", id);
    expect(round).toEqual(bytes);
    expect(db.raw.get(id)).toEqual(bytes);
  });

  test("raw upload with an id that does not match content is a 400", async () => {
    const e = await client().putRawBlob("demo", sha(99), new Uint8Array([1, 2, 3])).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(JrpError);
    expect((e as JrpError).code).toBe("bad_request");
    expect((e as JrpError).status).toBe(400);
  });

  test("raw download of a missing object is 404 not_found", async () => {
    const e = await client().getRawBlob("demo", sha(98)).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(JrpError);
    expect((e as JrpError).code).toBe("not_found");
    expect((e as JrpError).status).toBe(404);
  });

  test("statesLog walks parents newest first and paginates by cursor", async () => {
    const page1 = await client().statesLog("demo", { start: stateIds[2], limit: 2 });
    expect(lastBody).toEqual({ start: stateIds[2], limit: 2 });
    expect(page1.entries.map((e) => e.id)).toEqual([stateIds[2], stateIds[1]]);
    expect(page1.entries[0]?.message).toBe("fix: walker");
    expect(page1.nextCursor).toBeDefined();
    const page2 = await client().statesLog("demo", { start: stateIds[2], cursor: page1.nextCursor });
    expect(page2.entries.map((e) => e.id)).toEqual([stateIds[0]]);
    expect(page2.nextCursor).toBeUndefined();
  });

  test("statesLog of an unknown start is 404", async () => {
    const e = await client().statesLog("demo", { start: sha(77) }).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(JrpError);
    expect((e as JrpError).code).toBe("not_found");
  });

  test("provenance ingest is content-addressed and queryable", async () => {
    const record: ProvenanceRecord = {
      kind: "provenance",
      states: [stateIds[1]],
      agent: { name: "codex", adapter: "codex" },
      startedAt: NOW,
    };
    const id = await client().ingestProvenance("demo", record);
    expect(id).toBe(hashJson(record));
    const byAgent = await client().queryProvenance("demo", { agent: "codex" });
    expect(lastBody).toEqual({ agent: "codex" });
    expect(byAgent.records).toContainEqual(record);
    const byState = await client().queryProvenance("demo", { states: [stateIds[1]] });
    expect(byState.records).toContainEqual(record);
  });

  test("evidence ingest and query filter by state and rules", async () => {
    const record: EvidenceRecord = {
      kind: "evidence",
      state: stateIds[1],
      rules: "ci@sha256:abc",
      checks: [{ check: "build", status: "pass" }],
      at: NOW,
    };
    const id = await client().ingestEvidence("demo", record);
    expect(id).toBe(hashJson(record));
    const res = await client().queryEvidence("demo", { state: stateIds[1], rules: "ci@sha256:abc" });
    expect(lastBody).toEqual({ state: stateIds[1], rules: "ci@sha256:abc" });
    expect(res.records).toEqual([record]);
    const empty = await client().queryEvidence("demo", { state: stateIds[1], rules: "other@sha256:def" });
    expect(empty.records).toEqual([]);
  });

  test("contributions: create, list by status, publish via CAS", async () => {
    const id = await client().createContribution("demo", demoContribution);
    expect(id).toBe(hashJson(demoContribution));

    const open = await client().listContributions("demo", { status: "open" });
    expect(open.contributions).toEqual([{ id, ...demoContribution, status: "open" }]);

    const published = await client().updateContributionStatus("demo", id, {
      expected: "open",
      next: { status: "published", worldState: stateIds[2] },
    });
    expect(published).toEqual({ id, ok: true, status: "published" });
    expect(await client().listContributions("demo", { status: "open" })).toEqual({ contributions: [] });
  });

  test("contribution status CAS failures report per-id reasons", async () => {
    const id = await client().createContribution("demo", { ...demoContribution, title: "Second" });
    const mismatch = await client().updateContributionStatus("demo", id, {
      expected: "discarded",
      next: { status: "published", worldState: stateIds[2] },
    });
    expect(mismatch).toEqual({ id, ok: false, reason: "cas-mismatch" });

    await client().updateContributionStatus("demo", id, { expected: "open", next: { status: "discarded" } });
    const illegal = await client().updateContributionStatus("demo", id, {
      expected: "discarded",
      next: { status: "published", worldState: stateIds[2] },
    });
    expect(illegal).toEqual({ id, ok: false, reason: "illegal-transition" });
  });

  test("search filters by kind and paginates hits", async () => {
    const page1 = await client().search("demo", { query: "parse", kind: "code", limit: 1 });
    expect(lastBody).toEqual({ query: "parse", kind: "code", limit: 1 });
    expect(page1.hits).toEqual([{ kind: "code", blob: sha(30), path: "src/parse.ts", snippet: "parse tree walker", score: 0.93 }]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await client().search("demo", { query: "parse", kind: "code", cursor: page1.nextCursor });
    expect(page2.hits.map((h) => ("path" in h ? h.path : ""))).toEqual(["src/parser.ts"]);
    expect(page2.nextCursor).toBeUndefined();
    const history = await client().search("demo", { query: "feat", kind: "history" });
    expect(history.hits).toEqual([{ kind: "history", state: stateIds[2], snippet: "feat: parse tree", score: 0.7 }]);
  });

  test("trailing slash in baseUrl is normalized", async () => {
    expect(await new JavelinClient({ baseUrl: `${baseUrl}/`, token }).listRepos().then((r) => r.repos.length)).toBeGreaterThan(0);
  });

  test("pluggable fetch is used", async () => {
    let called = false;
    const c = new JavelinClient({
      baseUrl,
      token,
      fetch: async (input, init) => {
        called = true;
        return globalThis.fetch(input, init);
      },
    });
    await c.health();
    expect(called).toBe(true);
  });
});

describe("error and protocol paths", () => {
  test("401 unauthorized on missing token", async () => {
    const e = await new JavelinClient({ baseUrl }).listRepos().catch((e: unknown) => e);
    expect(e).toBeInstanceOf(JrpError);
    expect((e as JrpError).code).toBe("unauthorized");
    expect((e as JrpError).status).toBe(401);
    expect((e as JrpError).message).toBe("bad token");
  });

  test("version_not_supported surfaces the server's supported versions", async () => {
    const s = Bun.serve({
      port: 0,
      fetch: () => err("version_not_supported", "unsupported JRP version", 409, { supported: [1, 2] }),
    });
    try {
      const e = await new JavelinClient({ baseUrl: `http://localhost:${s.port}`, token })
        .listRepos()
        .catch((e: unknown) => e);
      expect(e).toBeInstanceOf(JrpError);
      expect((e as JrpError).code).toBe("version_not_supported");
      expect((e as JrpError).status).toBe(409);
      expect((e as JrpError).supported).toEqual([1, 2]);
    } finally {
      s.stop(true);
    }
  });

  test("server rejects an unsupported x-jrp-version with 409 and supported list", async () => {
    const res = await fetch(`${baseUrl}${routes.repos}`, {
      headers: { authorization: `Bearer ${token}`, "x-jrp-version": "1" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; supported: number[] } };
    expect(body.error.code).toBe("version_not_supported");
    expect(body.error.supported).toEqual([2]);
  });

  test("server rejects an over-limit JSON body with 413 payload_too_large", async () => {
    const res = await fetch(`${baseUrl}/jrp/v2/repos/demo/objects/batch-fetch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-jrp-version": "2", "content-type": "application/json" },
      body: JSON.stringify({ ids: ["a".repeat(MAX_BATCH_BYTES)] }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  test("oversize blob in batchUpload is rejected locally without fetching", async () => {
    let fetched = false;
    const c = new JavelinClient({
      baseUrl,
      token,
      fetch: async () => {
        fetched = true;
        throw new Error("fetch must not be called");
      },
    });
    const oversizeData = "A".repeat(Math.floor((MAX_OBJECT_BYTES * 4) / 3) + 4);
    const e = await c.batchUpload("demo", [{ id: sha(50), kind: "blob", data: oversizeData }]).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(LimitExceededError);
    expect((e as LimitExceededError).limit).toBe(MAX_OBJECT_BYTES);
    expect(fetched).toBe(false);
  });

  test("JSON body over MAX_BATCH_BYTES is rejected locally without fetching", async () => {
    let fetched = false;
    const c = new JavelinClient({
      baseUrl,
      token,
      fetch: async () => {
        fetched = true;
        throw new Error("fetch must not be called");
      },
    });
    const e = await c.queryProvenance("demo", { agent: "x".repeat(MAX_BATCH_BYTES + 1) }).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(LimitExceededError);
    expect((e as LimitExceededError).limit).toBe(MAX_BATCH_BYTES);
    expect(fetched).toBe(false);
  });

  test("missing envelope fields raise JrpProtocolError", async () => {
    const s = Bun.serve({ port: 0, fetch: () => json({ world: null }) });
    try {
      const e = await new JavelinClient({ baseUrl: `http://localhost:${s.port}`, token })
        .getHeads("demo")
        .catch((e: unknown) => e);
      expect(e).toBeInstanceOf(JrpProtocolError);
      expect((e as JrpProtocolError).message).toContain("layers");
    } finally {
      s.stop(true);
    }
  });

  test("JSON error body without an error envelope raises JrpProtocolError", async () => {
    const s = Bun.serve({ port: 0, fetch: () => json({ oops: true }, 500) });
    try {
      const e = await new JavelinClient({ baseUrl: `http://localhost:${s.port}`, token })
        .listRepos()
        .catch((e: unknown) => e);
      expect(e).toBeInstanceOf(JrpProtocolError);
      expect((e as JrpProtocolError).message).toContain("not a JRP error envelope");
    } finally {
      s.stop(true);
    }
  });

  test("non-JSON error body falls back to internal with the status line", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    try {
      const e = await new JavelinClient({ baseUrl: `http://localhost:${s.port}`, token })
        .listRepos()
        .catch((e: unknown) => e);
      expect(e).toBeInstanceOf(JrpError);
      expect((e as JrpError).code).toBe("internal");
      expect((e as JrpError).status).toBe(500);
    } finally {
      s.stop(true);
    }
  });
});
