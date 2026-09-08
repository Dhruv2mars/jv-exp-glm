import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  JavelinClient,
  JrpError,
  objectId,
  type CommitSummary,
  type RefUpdate,
  type SearchRequest,
  type SerializedObject,
} from "../src";

const sha = (n: number) => objectId(n.toString(16).padStart(64, "0"));

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const requests: { method: string; path: string; headers: Headers; body: unknown }[] = [];

function json(res: unknown, status = 200) {
  return new Response(JSON.stringify(res), { status, headers: { "content-type": "application/json" } });
}

function errJson(code: string, message: string, status: number) {
  return json({ error: { code, message } }, status);
}

function handler(pathname: string, body: unknown): Response {
  switch (pathname) {
    case "/jrp/v1/repos": {
      if (requests.at(-1)?.method === "GET")
        return json({ repos: [{ name: "demo", createdAt: "2026-01-01T00:00:00Z", defaultBranch: "refs/heads/main" }] });
      return json({ name: "demo", createdAt: "2026-01-01T00:00:00Z", defaultBranch: "refs/heads/main" });
    }
    case "/jrp/v1/repos/demo/refs":
      return json({ refs: { "refs/heads/main": sha(1) } });
    case "/jrp/v1/repos/demo/objects/fetch": {
      const b = body as { want?: unknown };
      if (!Array.isArray(b?.want)) return errJson("bad_request", "want required", 400);
      return json({ objects: [{ id: sha(1), kind: "blob", data: "hello" }] });
    }
    case "/jrp/v1/repos/demo/objects/upload": {
      const b = body as { objects?: SerializedObject[] };
      if (!b?.objects?.length) return errJson("bad_request", "objects required", 400);
      return json({ accepted: [sha(1)], rejected: [] });
    }
    case "/jrp/v1/repos/demo/refs/update": {
      const b = body as { updates?: RefUpdate[] };
      const u = b?.updates?.[0];
      if (!u) return errJson("bad_request", "updates required", 400);
      if (u.expectedOld !== null && u.expectedOld !== sha(1))
        return json({ results: [{ ref: u.ref, ok: false, reason: "cas-mismatch" }] });
      return json({ results: [{ ref: u.ref, ok: true }] });
    }
    case "/jrp/v1/repos/demo/log": {
      const commits: CommitSummary[] = [
        { id: sha(2), tree: sha(3), parents: [], author: { name: "a", email: "a@x", time: "2026-01-01T00:00:00Z" }, message: "feat: init" },
      ];
      return json({ commits });
    }
    case "/jrp/v1/repos/demo/search":
      return json({ hits: [{ kind: "code", path: "a.ts", snippet: "hello", score: 1 }] });
    default:
      return errJson("not_found", "no such route", 404);
  }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json() : null;
      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
      if (req.headers.get("authorization") !== "Bearer tok") return errJson("unauthorized", "bad token", 401);
      if (req.headers.get("x-jrp-version") !== "1") return errJson("bad_request", "bad version", 400);
      return handler(url.pathname, body);
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

function client() {
  return new JavelinClient({ baseUrl, token: "tok" });
}

describe("JavelinClient over real Bun.serve", () => {
  test("createRepo posts and parses RepoInfo", async () => {
    const repo = await client().createRepo({ name: "demo", defaultBranch: "refs/heads/main" });
    expect(repo.name).toBe("demo");
    const r = requests.at(-1);
    expect(r?.method).toBe("POST");
    expect(r?.path).toBe("/jrp/v1/repos");
    expect(r?.body).toEqual({ name: "demo", defaultBranch: "refs/heads/main" });
  });

  test("listRepos gets and parses ListReposResponse", async () => {
    const res = await client().listRepos();
    expect(res.repos[0]?.name).toBe("demo");
    const r = requests.at(-1);
    expect(r?.method).toBe("GET");
    expect(r?.body).toBeNull();
  });

  test("listRefs parses refs map", async () => {
    const res = await client().listRefs("demo");
    expect(res.refs["refs/heads/main"]).toBe(sha(1));
    expect(requests.at(-1)?.path).toBe("/jrp/v1/repos/demo/refs");
  });

  test("fetchObjects sends want ids and parses objects", async () => {
    const res = await client().fetchObjects("demo", [sha(1)]);
    expect(res.objects[0]).toEqual({ id: sha(1), kind: "blob", data: "hello" });
    expect(requests.at(-1)?.body).toEqual({ want: [sha(1)] });
  });

  test("uploadObjects sends objects and parses accepted", async () => {
    const obj: SerializedObject = { id: sha(1), kind: "blob", data: "hello" };
    const res = await client().uploadObjects("demo", [obj]);
    expect(res.accepted).toEqual([sha(1)]);
    expect(res.rejected).toEqual([]);
    expect(requests.at(-1)?.body).toEqual({ objects: [obj] });
  });

  test("updateRefs sends updates and parses results", async () => {
    const updates: RefUpdate[] = [{ ref: "refs/heads/main", expectedOld: sha(1), new: sha(4) }];
    const res = await client().updateRefs("demo", updates);
    expect(res.results[0]?.ok).toBe(true);
    expect(requests.at(-1)?.body).toEqual({ updates });
  });

  test("updateRefs surfaces cas-mismatch results", async () => {
    const updates: RefUpdate[] = [{ ref: "refs/heads/main", expectedOld: sha(9), new: sha(4) }];
    const res = await client().updateRefs("demo", updates);
    expect(res.results[0]).toEqual({ ref: "refs/heads/main", ok: false, reason: "cas-mismatch" });
  });

  test("log sends start and limit", async () => {
    const res = await client().log("demo", sha(2), 10);
    expect(res.commits[0]?.message).toBe("feat: init");
    expect(requests.at(-1)?.body).toEqual({ start: sha(2), limit: 10 });
  });

  test("search sends query, kind, limit", async () => {
    const res = await client().search("demo", "hello", { kind: "code", limit: 5 });
    expect(res.hits[0]?.path).toBe("a.ts");
    expect(requests.at(-1)?.body).toEqual({ query: "hello", kind: "code", limit: 5 });
  });

  test("sends auth and protocol headers", () => {
    const r = requests[0];
    expect(r?.headers.get("authorization")).toBe("Bearer tok");
    expect(r?.headers.get("x-jrp-version")).toBe("1");
  });

  test("trailing slash in baseUrl is normalized", async () => {
    const res = await new JavelinClient({ baseUrl: `${baseUrl}/`, token: "tok" }).listRepos();
    expect(res.repos).toHaveLength(1);
  });
});

describe("error paths", () => {
  test("401 unauthorized", async () => {
    const e = await new JavelinClient({ baseUrl }).listRepos().catch((e: unknown) => e);
    expect(e).toBeInstanceOf(JrpError);
    expect((e as JrpError).code).toBe("unauthorized");
    expect((e as JrpError).status).toBe(401);
    expect((e as JrpError).message).toBe("bad token");
  });

  test("404 not_found for missing repo", async () => {
    const e = await client().listRefs("missing").catch((e: unknown) => e);
    expect(e).toBeInstanceOf(JrpError);
    expect((e as JrpError).code).toBe("not_found");
    expect((e as JrpError).status).toBe(404);
  });

  test("409 conflict", async () => {
    const conflict = Bun.serve({
      port: 0,
      fetch: () => errJson("conflict", "ref already exists", 409),
    });
    try {
      const e = await new JavelinClient({ baseUrl: `http://localhost:${conflict.port}`, token: "t" })
        .createRepo({ name: "demo" })
        .catch((e: unknown) => e);
      expect((e as JrpError).code).toBe("conflict");
      expect((e as JrpError).status).toBe(409);
    } finally {
      conflict.stop(true);
    }
  });

  test("non-JSON error body falls back to status line", async () => {
    const raw = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    try {
      const e = await new JavelinClient({ baseUrl: `http://localhost:${raw.port}` })
        .listRepos()
        .catch((e: unknown) => e);
      expect((e as JrpError).code).toBe("internal");
      expect((e as JrpError).status).toBe(500);
    } finally {
      raw.stop(true);
    }
  });

  test("pluggable fetch is used", async () => {
    let called = false;
    const c = new JavelinClient({
      baseUrl,
      token: "tok",
      fetch: async (input, init) => {
        called = true;
        return globalThis.fetch(input, init);
      },
    });
    await c.listRepos();
    expect(called).toBe(true);
  });
});
