import { ERROR_HTTP_STATUS, JrpError, RAW_CONTENT_TYPE, type Cursor, type ObjectId } from "@javelin/sdk";
import { JavelinClient } from "@javelin/sdk";
import { errorPage, notFoundPage } from "./html";
import {
  asContribution,
  asState,
  blobBytes,
  fetchObjects,
  NotFound,
  objectIdOf,
  parseObjectId,
  parseRefSpec,
  type State,
} from "./javelin";
import {
  parseSearchKind,
  renderBlob,
  renderBrowse,
  renderContribution,
  renderContributions,
  renderHome,
  renderLayerLog,
  renderLayers,
  renderOverview,
  renderSearch,
  renderStateDetail,
  renderWorldLog,
} from "./pages";

export interface WebServerOptions {
  javelindUrl: string;
  token?: string;
  port?: number;
}

export interface WebServer {
  port: number;
  hostname: string;
  stop(): void;
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class PageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function decodeSeg(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type Params = Record<string, string | string[]>;

function match(pattern: string, seg: string[]): Params | null {
  const parts = pattern.split("/").filter(Boolean);
  const params: Params = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "*rest") {
      params.rest = seg.slice(i).map(decodeSeg);
      return params;
    }
    if (seg[i] === undefined) return null;
    if (part.startsWith(":")) params[part.slice(1)] = decodeSeg(seg[i]!);
    else if (part !== seg[i]) return null;
  }
  return seg.length === parts.length ? params : null;
}

function one(params: Params, key: string): string {
  return params[key] as string;
}

function rest(params: Params): string[] {
  return (params.rest as string[]) ?? [];
}

function cursorParam(url: URL): Cursor | undefined {
  const raw = url.searchParams.get("cursor");
  return raw ? (raw as Cursor) : undefined;
}

export function createWebServer(opts: WebServerOptions): WebServer {
  const client = new JavelinClient({ baseUrl: opts.javelindUrl, token: opts.token });

  async function publishAction(repo: string, id: ObjectId): Promise<Response> {
    const heads = await client.getHeads(repo);
    const world = heads.world;
    if (!world) throw new PageError(409, "the world head is unset; there is nothing to publish into");
    const contribution = asContribution((await fetchObjects(client, repo, [id])).get(id));
    if (!contribution) throw new NotFound(`contribution not found: ${id}`);
    const proposed = asState((await fetchObjects(client, repo, [contribution.state])).get(contribution.state));
    if (!proposed) throw new NotFound(`proposed state not found: ${contribution.state}`);
    let worldState: ObjectId;
    if (contribution.state === world) {
      worldState = world;
    } else if (contribution.base === world) {
      const merged: State = {
        kind: "state",
        tree: proposed.tree,
        parents: [world, contribution.state],
        author: { name: "javelin-web", email: "web@javelin.local", time: new Date().toISOString() },
        message: `publish ${contribution.layer}: ${contribution.title}`,
      };
      const mergedId = await objectIdOf(merged);
      const upload = await client.batchUpload(repo, [{ id: mergedId, kind: "state", object: merged }]);
      if (!upload.accepted.includes(mergedId)) {
        throw new PageError(500, `server rejected the merged state: ${upload.rejected[0]?.reason ?? "unknown"}`);
      }
      const results = await client.updateHeads(repo, [{ key: "world", expected: world, next: mergedId }]);
      if (!results[0]?.ok) throw new PageError(409, "the world head moved during publish; refresh the layer and retry");
      worldState = mergedId;
    } else {
      throw new PageError(409, "the world advanced past this contribution's base; refresh the layer and retry");
    }
    const status = await client.updateContributionStatus(repo, id, {
      expected: "open",
      next: { status: "published", worldState },
    });
    if (!status.ok) throw new PageError(409, `could not mark the contribution published: ${status.reason}`);
    return redirect(`/${repo}/contribution/${id}`);
  }

  async function discardAction(repo: string, id: ObjectId): Promise<Response> {
    const status = await client.updateContributionStatus(repo, id, {
      expected: "open",
      next: { status: "discarded" },
    });
    if (!status.ok) throw new PageError(409, `could not discard the contribution: ${status.reason}`);
    return redirect(`/${repo}/contribution/${id}`);
  }

  /** Raw storage only holds blobs that arrived over the raw endpoint; everything else is served from the batch store. */
  async function rawBytes(repo: string, id: ObjectId): Promise<Uint8Array | null> {
    try {
      return await client.getRawBlob(repo, id);
    } catch (e) {
      if (!(e instanceof JrpError) || e.code !== "not_found") throw e;
    }
    return blobBytes((await fetchObjects(client, repo, [id])).get(id));
  }

  type Ctx = { req: Request; url: URL; params: Params };

  interface Route {
    method: string;
    pattern: string;
    handle: (ctx: Ctx) => Promise<Response> | Response;
  }

  async function pageResponse(body: Promise<string>, status = 200): Promise<Response> {
    return htmlResponse(await body, status);
  }

  const routes: Route[] = [
    { method: "GET", pattern: "/", handle: () => pageResponse(renderHome(client)) },
    {
      method: "POST",
      pattern: "/-/repos",
      handle: async ({ req }) => {
        const form = await req.formData();
        const name = String(form.get("name") ?? "").trim();
        const description = String(form.get("description") ?? "").trim();
        if (!REPO_NAME.test(name)) return htmlResponse(await renderHome(client, `Invalid repository name: ${name}`), 400);
        await client.createRepo({ name, ...(description ? { description } : {}) });
        return redirect(`/${name}`);
      },
    },
    { method: "GET", pattern: "/:repo", handle: ({ params }) => pageResponse(renderOverview(client, one(params, "repo"))) },
    {
      method: "GET",
      pattern: "/:repo/world",
      handle: ({ params, url }) => pageResponse(renderWorldLog(client, one(params, "repo"), cursorParam(url))),
    },
    {
      method: "GET",
      pattern: "/:repo/state/:id",
      handle: ({ params }) => pageResponse(renderStateDetail(client, one(params, "repo"), one(params, "id"))),
    },
    { method: "GET", pattern: "/:repo/layers", handle: ({ params }) => pageResponse(renderLayers(client, one(params, "repo"))) },
    {
      method: "GET",
      pattern: "/:repo/layer/:name",
      handle: ({ params, url }) => pageResponse(renderLayerLog(client, one(params, "repo"), one(params, "name"), cursorParam(url))),
    },
    {
      method: "GET",
      pattern: "/:repo/browse/*rest",
      handle: ({ params }) => {
        const repo = one(params, "repo");
        const seg = rest(params);
        const refRaw = seg[0] === "layer" ? `layer/${seg[1] ?? ""}` : (seg[0] ?? "");
        const ref = parseRefSpec(refRaw);
        if (!ref) throw new NotFound(`unknown ref: ${refRaw}`);
        const segments = ref === "world" ? seg.slice(1) : seg.slice(2);
        return pageResponse(renderBrowse(client, repo, ref, segments));
      },
    },
    {
      method: "GET",
      pattern: "/:repo/blob/:id/*rest",
      handle: ({ params }) => pageResponse(renderBlob(client, one(params, "repo"), one(params, "id"), rest(params))),
    },
    {
      method: "GET",
      pattern: "/:repo/raw/:id",
      handle: async ({ params }) => {
        const repo = one(params, "repo");
        const id = parseObjectId(one(params, "id"));
        if (!id) throw new NotFound(`invalid object id: ${one(params, "id")}`);
        const bytes = await rawBytes(repo, id);
        if (!bytes) throw new NotFound(`blob not found: ${id}`);
        return new Response(bytes as unknown as BodyInit, { headers: { "content-type": RAW_CONTENT_TYPE } });
      },
    },
    {
      method: "GET",
      pattern: "/:repo/contributions",
      handle: ({ params, url }) => pageResponse(renderContributions(client, one(params, "repo"), cursorParam(url))),
    },
    {
      method: "GET",
      pattern: "/:repo/contribution/:id",
      handle: ({ params }) => pageResponse(renderContribution(client, one(params, "repo"), one(params, "id"))),
    },
    {
      method: "POST",
      pattern: "/:repo/contribution/:id/publish",
      handle: ({ params }) => {
        const id = parseObjectId(one(params, "id"));
        if (!id) throw new NotFound(`invalid contribution id: ${one(params, "id")}`);
        return publishAction(one(params, "repo"), id);
      },
    },
    {
      method: "POST",
      pattern: "/:repo/contribution/:id/discard",
      handle: ({ params }) => {
        const id = parseObjectId(one(params, "id"));
        if (!id) throw new NotFound(`invalid contribution id: ${one(params, "id")}`);
        return discardAction(one(params, "repo"), id);
      },
    },
    {
      method: "GET",
      pattern: "/:repo/search",
      handle: ({ params, url }) =>
        pageResponse(
          renderSearch(
            client,
            one(params, "repo"),
            url.searchParams.get("q") ?? "",
            parseSearchKind(url.searchParams.get("kind")),
            cursorParam(url),
          ),
        ),
    },
  ];

  async function handle(req: Request, url: URL): Promise<Response> {
    const seg = url.pathname.split("/").filter(Boolean);
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const params = match(route.pattern, seg);
      if (params === null) continue;
      if (route.pattern.startsWith("/:repo") && !REPO_NAME.test(one(params, "repo"))) throw new NotFound(`repository not found: ${one(params, "repo")}`);
      return await route.handle({ req, url, params });
    }
    throw new NotFound(`no page: ${req.method} ${url.pathname}`);
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch: async (req) => {
      try {
        return await handle(req, new URL(req.url));
      } catch (e) {
        if (e instanceof NotFound) return htmlResponse(notFoundPage(e.message), 404);
        if (e instanceof PageError) return htmlResponse(errorPage(e.status, e.message), e.status);
        if (e instanceof JrpError) {
          const status = ERROR_HTTP_STATUS[e.code];
          return htmlResponse(e.code === "not_found" ? notFoundPage(e.message) : errorPage(status, `${e.code}: ${e.message}`), status);
        }
        const message = e instanceof Error ? e.message : String(e);
        return htmlResponse(errorPage(500, message), 500);
      }
    },
  });

  return {
    port: server.port ?? 0,
    hostname: server.hostname ?? "localhost",
    stop: () => server.stop(true),
  };
}
