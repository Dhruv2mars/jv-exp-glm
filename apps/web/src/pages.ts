import type { JavelinClient } from "@javelin/sdk";
import { objectId, type ObjectId } from "@javelin/protocol";
import { esc, notFound, page } from "./html";
import {
  asCommit,
  asTree,
  decodeBlob,
  fetchObjects,
  listTreeFiles,
  lookupPath,
  NotFound,
  ObjMap,
  resolveCommit,
} from "./repo";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function short(id: string): string {
  return id.slice(0, 8);
}

function crumb(repo: string, segments: string[], href: string): string {
  let acc = "";
  const parts = segments.map((seg, i) => {
    acc = acc ? `${acc}/${seg}` : seg;
    const last = i === segments.length - 1;
    return last ? `<strong>${esc(seg)}</strong>` : `<a href="${href}/${acc}">${esc(seg)}</a>`;
  });
  return `<p class="muted">${esc(repo)} / ${parts.join(" / ")}</p>`;
}

export async function renderHome(client: JavelinClient, flash?: string): Promise<string> {
  const { repos } = await client.listRepos();
  const rows = repos
    .map(
      (r) => `<tr>
  <td><a href="/${esc(r.name)}">${esc(r.name)}</a>${r.description ? `<div class="muted">${esc(r.description)}</div>` : ""}</td>
  <td><span class="refchip">${esc(r.defaultBranch)}</span></td>
  <td class="muted">${esc(fmtTime(r.createdAt))}</td>
</tr>`,
    )
    .join("\n");
  const table =
    repos.length === 0
      ? `<p class="muted">No repositories yet. Create the first one below.</p>`
      : `<table class="list"><tr><th>Repository</th><th>Default branch</th><th>Created</th></tr>${rows}</table>`;
  return page(
    "Repositories",
    `${flash ? `<div class="card">${esc(flash)}</div>` : ""}
<h1>Repositories</h1>
${table}
<div class="card">
  <h2>New repository</h2>
  <form class="inline" method="post" action="/-/repos">
    <input type="text" name="name" placeholder="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*">
    <input type="text" name="defaultBranch" placeholder="default branch (main)">
    <button type="submit">Create</button>
  </form>
</div>`,
  );
}

export async function renderRepoSummary(client: JavelinClient, repo: string): Promise<string> {
  const [{ refs }, head] = await Promise.all([
    client.listRefs(repo),
    resolveCommit(client, repo, "main").catch(() => null),
  ]);
  const refRows = Object.entries(refs)
    .map(
      ([name, id]) =>
        `<tr><td>${esc(name)}</td><td><a href="/${esc(repo)}/commit/${esc(id)}"><code>${esc(short(id))}</code></a></td></tr>`,
    )
    .join("\n");
  let recent = "";
  if (head) {
    const { commits } = await client.log(repo, head, 5);
    recent = `<div class="card"><h2>Recent commits</h2><table class="list">${commits
      .map(
        (c) =>
          `<tr><td><a href="/${esc(repo)}/commit/${esc(c.id)}">${esc(c.message.split("\n")[0]!)}</a></td><td class="muted">${esc(c.author.name)}</td><td class="muted">${esc(fmtTime(c.author.time))}</td></tr>`,
      )
      .join("")}</table></div>`;
  }
  const browseHref = head ? `<p><a href="/${esc(repo)}/browse/${esc(short(head))}">Browse files</a></p>` : "";
  return page(
    repo,
    `<h1>${esc(repo)}</h1>${browseHref}
<div class="card"><h2>Refs</h2><table class="list"><tr><th>Ref</th><th>Commit</th></tr>${refRows}</table></div>
${recent}`,
    { repo, tab: "code" },
  );
}

export async function renderCommits(client: JavelinClient, repo: string, ref: string | undefined): Promise<string> {
  const start = await resolveCommit(client, repo, ref ?? "main");
  const { commits } = await client.log(repo, start, 100);
  const rows = commits
    .map(
      (c) => `<tr>
  <td><a href="/${esc(repo)}/commit/${esc(c.id)}">${esc(c.message.split("\n")[0]!)}</a></td>
  <td>${esc(c.author.name)}</td>
  <td class="muted">${esc(fmtTime(c.author.time))}</td>
  <td><code class="muted">${esc(short(c.id))}</code></td>
</tr>`,
    )
    .join("\n");
  return page(
    `${repo} commits`,
    `<h1>Commits in ${esc(repo)}</h1>
<table class="list"><tr><th>Message</th><th>Author</th><th>Time</th><th>Commit</th></tr>${rows}</table>`,
    { repo, tab: "commits" },
  );
}

export async function renderCommit(client: JavelinClient, repo: string, id: string): Promise<string> {
  const objects = await fetchObjects(client, repo, [id]);
  const commit = asCommit(objects.get(id));
  if (!commit) throw new NotFound(`commit not found: ${id}`);
  const parent = commit.parents[0];
  const filesHere = await listTreeFiles(client, repo, commit.tree);
  const changed: string[] = [];
  if (parent) {
    const pObjects = await fetchObjects(client, repo, [parent]);
    const pCommit = asCommit(pObjects.get(parent));
    if (pCommit) {
      const filesBefore = await listTreeFiles(client, repo, pCommit.tree);
      for (const [path, blob] of filesHere) if (filesBefore.get(path) !== blob) changed.push(path);
      for (const path of filesBefore.keys()) if (!filesHere.has(path)) changed.push(path);
    }
  } else {
    changed.push(...filesHere.keys());
  }
  changed.sort();
  const parentLink = parent
    ? `<a href="/${esc(repo)}/commit/${esc(parent)}">parent ${esc(short(parent))}</a>`
    : `<span class="muted">root commit</span>`;
  const fileRows = changed
    .map(
      (p) =>
        `<tr><td><a href="/${esc(repo)}/blob/${esc(id)}/${esc(p)}">${esc(p)}</a></td></tr>`,
    )
    .join("\n");
  return page(
    `${short(id)} · ${repo}`,
    `<h1><code>${esc(short(id))}</code> <span class="muted">in ${esc(repo)}</span></h1>
<div class="card">
  <pre>${esc(commit.message)}</pre>
  <p class="muted">${esc(commit.author.name)} &lt;${esc(commit.author.email)}&gt; · ${esc(fmtTime(commit.author.time))} · ${parentLink}</p>
</div>
<div class="card"><h2>Changed files (${changed.length})</h2>
<table class="list">${fileRows}</table>
<p class="muted">Patch-style diffs are not available yet; this lists the files touched by the commit.</p>
</div>`,
    { repo, tab: "commits" },
  );
}

export async function renderBrowse(
  client: JavelinClient,
  repo: string,
  ref: string,
  segments: string[],
): Promise<string> {
  const commitId = await resolveCommit(client, repo, ref);
  const hit = await lookupPath(client, repo, commitId, segments);
  if (hit === null) throw new NotFound(`path not found in ${repo}@${ref}`);
  if (hit.kind === "blob") {
    const objects = await fetchObjects(client, repo, [hit.id]);
    return renderBlobContent(client, repo, ref, segments, decodeBlob(objects.get(hit.id)));
  }
  const entries = asTree((await fetchObjects(client, repo, [hit.id])).get(hit.id));
  const dirsFirst = [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "tree" ? -1 : 1));
  const base = `/${repo}/browse/${ref}`;
  const rows = dirsFirst
    .map((e) => {
      const icon = e.kind === "tree" ? "&#128193;" : "&#128196;";
      const name = e.kind === "tree" ? `<a href="${base}/${esc(segments.concat(e.name).join("/"))}">${esc(e.name)}/</a>` : `<a href="/${esc(repo)}/blob/${esc(ref)}/${esc(segments.concat(e.name).join("/"))}">${esc(e.name)}</a>`;
      return `<tr><td>${icon}</td><td>${name}</td><td><code class="muted">${esc(short(e.id))}</code></td></tr>`;
    })
    .join("\n");
  return page(
    `${repo}: ${segments.join("/") || "/"}`,
    `<h1>${esc(repo)} <span class="refchip">${esc(ref)}</span></h1>
${crumb(repo, segments, base)}
<table class="list tree"><tr><th></th><th>Name</th><th>Object</th></tr>
${segments.length > 0 ? `<tr><td></td><td colspan="2"><a href="${base}/${esc(segments.slice(0, -1).join("/")) || base}">..</a></td></tr>` : ""}
${rows}
</table>`,
    { repo, tab: "code" },
  );
}

function renderBlobContent(
  client: JavelinClient,
  repo: string,
  ref: string,
  segments: string[],
  data: string | null,
): string {
  if (data === null) throw new NotFound("blob not found");
  const lines = data.split("\n");
  const body = lines
    .map((line, i) => `<div class="line"><span class="ln">${i + 1}</span><span class="src">${esc(line)}</span></div>`)
    .join("\n");
  return page(
    `${segments.join("/")} · ${repo}`,
    `<h1>${esc(repo)} <span class="refchip">${esc(ref)}</span></h1>
${crumb(repo, segments.slice(0, -1), `/${repo}/browse/${ref}`)}
<p class="muted">${lines.length} lines</p>
<div class="blob">${body}</div>`,
    { repo, tab: "code" },
  );
}

export async function renderBlob(
  client: JavelinClient,
  repo: string,
  ref: string,
  segments: string[],
): Promise<string> {
  const commitId = await resolveCommit(client, repo, ref);
  const hit = await lookupPath(client, repo, commitId, segments);
  if (hit === null || hit.kind !== "blob") throw new NotFound(`file not found in ${repo}@${ref}`);
  const objects = await fetchObjects(client, repo, [hit.id]);
  return renderBlobContent(client, repo, ref, segments, decodeBlob(objects.get(hit.id)));
}

export async function renderSearch(client: JavelinClient, repo: string, query: string, ref: string): Promise<string> {
  const results = query
    ? await searchCode(client, repo, ref, query)
    : [];
  const hits = results
    .map(
      (h) => `<div class="hit">
  <a href="/${esc(repo)}/blob/${esc(ref)}/${esc(h.path)}">${esc(h.path)}</a>
  <pre>${esc(h.snippet)}</pre>
</div>`,
    )
    .join("\n");
  return page(
    `Search ${repo}`,
    `<h1>Search in ${esc(repo)}</h1>
<form class="inline" method="get" action="/${esc(repo)}/search">
  <input type="text" name="q" value="${esc(query)}" placeholder="Search code…">
  <button type="submit">Search</button>
</form>
${query ? `<p class="muted">${results.length} match${results.length === 1 ? "" : "es"} for “${esc(query)}”</p>${hits || "<p class=\"muted\">No matches.</p>"}` : ""}
`,
    { repo, tab: "search" },
  );
}

interface CodeHit {
  path: string;
  snippet: string;
}

/**
 * javelind's search endpoint does not index content yet, so this greps the
 * head tree blobs fetched through the SDK. Everything still goes over JRP.
 */
export async function searchCode(client: JavelinClient, repo: string, ref: string, query: string): Promise<CodeHit[]> {
  const commitId = await resolveCommit(client, repo, ref);
  const commit = asCommit((await fetchObjects(client, repo, [commitId])).get(commitId));
  if (!commit) return [];
  const files = await listTreeFiles(client, repo, commit.tree);
  const ids = [...new Set([...files.values()].map(String))];
  const objects: ObjMap = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    for (const o of (await client.fetchObjects(repo, ids.slice(i, i + 100) as ObjectId[])).objects) objects.set(o.id, o);
  }
  const needle = query.toLowerCase();
  const hits: CodeHit[] = [];
  for (const [path, id] of files) {
    const data = decodeBlob(objects.get(String(id)));
    if (data === null || data.length > 512 * 1024) continue;
    const lineIdx = data.split("\n").findIndex((l) => l.toLowerCase().includes(needle));
    if (lineIdx < 0) continue;
    const lines = data.split("\n");
    const from = Math.max(0, lineIdx - 1);
    hits.push({ path, snippet: lines.slice(from, lineIdx + 2).join("\n") });
    if (hits.length >= 50) break;
  }
  return hits;
}
