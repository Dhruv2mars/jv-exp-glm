import { JavelinClient } from "@javelin/sdk";
import { notFound, page } from "./html";
import { renderBrowse, renderBlob, renderCommit, renderCommits, renderHome, renderRepoSummary, renderSearch, parseSearchKind } from "./pages";
import { NotFound, REPO_NAME, resolveCommit } from "./repo";

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

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function createWebServer(opts: WebServerOptions): WebServer {
  const client = new JavelinClient({ baseUrl: opts.javelindUrl, token: opts.token });

  async function handle(req: Request, url: URL): Promise<Response> {
    const seg = url.pathname.split("/").filter(Boolean);
    const method = req.method;

    if (seg.length === 0 && method === "GET") return html(await renderHome(client));

    if (seg[0] === "-" && seg[1] === "repos" && method === "POST") {
      const form = await req.formData();
      const name = String(form.get("name") ?? "");
      const branch = String(form.get("defaultBranch") ?? "").trim();
      if (!REPO_NAME.test(name)) return html(await renderHome(client, `Invalid repository name: ${name}`), 400);
      await client.createRepo({ name, ...(branch ? { defaultBranch: branch } : {}) });
      return new Response(null, { status: 303, headers: { location: `/${name}` } });
    }

    if (seg.length === 1 && method === "GET") {
      const repo = seg[0]!;
      if (!REPO_NAME.test(repo)) throw new NotFound(`repository not found: ${repo}`);
      return html(await renderRepoSummary(client, repo));
    }

    if (seg.length === 2 && seg[1] === "commits" && method === "GET") {
      return html(await renderCommits(client, seg[0]!, url.searchParams.get("ref") ?? undefined));
    }

    if (seg.length === 3 && seg[1] === "commit" && method === "GET") {
      return html(await renderCommit(client, seg[0]!, seg[2]!));
    }

    if (seg.length >= 3 && seg[1] === "browse" && method === "GET") {
      return html(await renderBrowse(client, seg[0]!, seg[2]!, seg.slice(3)));
    }

    if (seg.length >= 4 && seg[1] === "blob" && method === "GET") {
      return html(await renderBlob(client, seg[0]!, seg[2]!, seg.slice(3)));
    }

    if (seg.length === 2 && seg[1] === "search" && method === "GET") {
      const repo = seg[0]!;
      const q = url.searchParams.get("q") ?? "";
      const ref = url.searchParams.get("ref") ?? (await defaultRef(client, repo));
      const kind = parseSearchKind(url.searchParams.get("kind"));
      return html(await renderSearch(client, repo, q, ref, kind));
    }

    throw new NotFound(`no page: ${method} ${url.pathname}`);
  }

  async function defaultRef(client: JavelinClient, repo: string): Promise<string> {
    const head = await resolveCommit(client, repo, "main");
    return head;
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch: async (req) => {
      try {
        return await handle(req, new URL(req.url));
      } catch (e) {
        if (e instanceof NotFound) return html(notFound(e.message), 404);
        if (e instanceof Error && e.name === "JrpError" && "status" in e) {
          const status = (e as { status: number }).status;
          if (status === 404) return html(notFound(e.message), 404);
          if (status === 400) return html(page("Bad request", `<div class="error"><div class="code">400</div><p>${e.message.replace(/[&<>"']/g, "")}</p></div>`), 400);
        }
        const message = e instanceof Error ? e.message : String(e);
        return html(page("Error", `<div class="error"><div class="code">500</div><p>${message.replace(/[&<>"']/g, "")}</p></div>`), 500);
      }
    },
  });

  return {
    port: server.port ?? 0,
    hostname: server.hostname ?? "localhost",
    stop: () => server.stop(true),
  };
}
