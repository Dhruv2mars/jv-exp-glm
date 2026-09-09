import type { Cursor, JavelinClient, ObjectId, RepoSearchResponse, SearchResult, StateLogEntry } from "@javelin/sdk";
import { esc, fmtTime, page, short, statusBadge } from "./html";
import {
  asContribution,
  asState,
  asTree,
  blobBytes,
  fetchObjects,
  flattenTree,
  isBinary,
  NotFound,
  parseObjectId,
  refBase,
  refHead,
  treeDiff,
  type RefSpec,
} from "./javelin";

const PAGE_SIZE = 25;

function stateHref(repo: string, id: string): string {
  return `/${esc(repo)}/state/${esc(id)}`;
}

function blobHref(repo: string, id: string, path: string): string {
  return `/${esc(repo)}/blob/${esc(id)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function layerLogHref(repo: string, name: string): string {
  return `/${esc(repo)}/layer/${encodeURIComponent(name)}`;
}

function browseHref(repo: string, ref: RefSpec, segments: string[] = []): string {
  const encoded = segments.map(encodeURIComponent).join("/");
  const tail = encoded ? `/${encoded}` : "";
  return `/${esc(repo)}/browse/${ref}${tail}`;
}

function shortId(repo: string, id: string | null, none = "none"): string {
  if (id === null) return `<span class="muted">${esc(none)}</span>`;
  return `<a href="${stateHref(repo, id)}"><code>${esc(short(id))}</code></a>`;
}

async function logPage(client: JavelinClient, repo: string, start: ObjectId, cursor?: Cursor) {
  return client.statesLog(repo, { start, ...(cursor ? { cursor } : {}), limit: PAGE_SIZE });
}

function logTable(repo: string, entries: StateLogEntry[]): string {
  const rows = entries
    .map(
      (e) => `<tr>
  <td><a href="${stateHref(repo, e.id)}">${esc(e.message.split("\n")[0]!)}</a></td>
  <td>${esc(e.author.name)}</td>
  <td class="muted">${esc(fmtTime(e.author.time))}</td>
  <td>${e.parents.map((p) => `<code class="muted">${esc(short(p))}</code>`).join(" ") || '<span class="muted">root</span>'}</td>
</tr>`,
    )
    .join("\n");
  return `<table class="list"><tr><th>State</th><th>Author</th><th>Time</th><th>Parents</th></tr>${rows}</table>`;
}

function nextLink(href: string, cursor: Cursor | undefined): string {
  return cursor ? `<p><a href="${href}${href.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}">Next page &rarr;</a></p>` : "";
}

export async function renderHome(client: JavelinClient, flash?: string): Promise<string> {
  const { repos, nextCursor } = await client.listRepos();
  const rows = repos
    .map(
      (r) => `<tr>
  <td><a href="/${esc(r.name)}">${esc(r.name)}</a>${r.description ? `<div class="muted">${esc(r.description)}</div>` : ""}</td>
  <td class="muted">${esc(fmtTime(r.createdAt))}</td>
</tr>`,
    )
    .join("\n");
  const table =
    repos.length === 0
      ? `<p class="muted">No repositories yet. Create the first world below.</p>`
      : `<table class="list"><tr><th>Repository</th><th>Created</th></tr>${rows}</table>${nextLink("/", nextCursor)}`;
  return page(
    "Repositories",
    `${flash ? `<div class="card">${esc(flash)}</div>` : ""}
<h1>Repositories</h1>
${table}
<div class="card">
  <h2>New repository</h2>
  <form class="inline" method="post" action="/-/repos">
    <input type="text" name="name" placeholder="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*">
    <input type="text" name="description" placeholder="description">
    <button type="submit">Create</button>
  </form>
</div>`,
  );
}

export async function renderOverview(client: JavelinClient, repo: string): Promise<string> {
  const heads = await client.getHeads(repo);
  const openContributions = await client.listContributions(repo, { status: "open" });
  const recent = heads.world ? (await client.statesLog(repo, { start: heads.world, limit: 5 })).entries : [];
  const worldCard = heads.world
    ? `<div class="card"><h2>World</h2>
  <p>World head <a href="${stateHref(repo, heads.world)}"><code>${esc(short(heads.world))}</code></a>
  &middot; <a href="${browseHref(repo, "world")}">Browse files</a> &middot; <a href="/${esc(repo)}/world">World log</a></p>
${recent.length > 1 ? logTable(repo, recent) : ""}
</div>`
    : `<div class="card"><h2>World</h2><p class="muted">Nothing published yet; the world head is unset.</p></div>`;
  const layerRows = heads.layers
    .map(
      (l) => `<tr>
  <td><a href="${layerLogHref(repo, l.name)}">${esc(l.name)}</a></td>
  <td>${shortId(repo, l.base)}</td>
  <td>${shortId(repo, l.head)}</td>
  <td class="muted">${esc(fmtTime(l.updatedAt))}</td>
  <td><a href="${browseHref(repo, `layer/${l.name}` as RefSpec)}">browse</a></td>
</tr>`,
    )
    .join("\n");
  const layersCard = `<div class="card"><h2>Layers</h2>${
    heads.layers.length === 0
      ? '<p class="muted">No layers yet.</p>'
      : `<table class="list"><tr><th>Name</th><th>Base</th><th>Head</th><th>Updated</th><th></th></tr>${layerRows}</table><p><a href="/${esc(repo)}/layers">All layers</a></p>`
  }</div>`;
  const contribRows = openContributions.contributions
    .map(
      (c) => `<tr>
  <td><a href="/${esc(repo)}/contribution/${esc(c.id)}">${esc(c.title)}</a></td>
  <td>${esc(c.layer)}</td>
  <td>${statusBadge(c.status)}</td>
</tr>`,
    )
    .join("\n");
  const contribCard = `<div class="card"><h2>Open contributions (${openContributions.contributions.length})</h2>${
    openContributions.contributions.length === 0
      ? '<p class="muted">No open contributions.</p>'
      : `<table class="list"><tr><th>Title</th><th>Layer</th><th>Status</th></tr>${contribRows}</table><p><a href="/${esc(repo)}/contributions">All contributions</a></p>`
  }</div>`;
  return page(repo, `<h1>${esc(repo)}</h1>${worldCard}${layersCard}${contribCard}`, { repo, tab: "overview" });
}

export async function renderWorldLog(client: JavelinClient, repo: string, cursor?: Cursor): Promise<string> {
  const heads = await client.getHeads(repo);
  if (!heads.world) throw new NotFound(`repository ${repo} has no world states yet`);
  const { entries, nextCursor } = await logPage(client, repo, heads.world, cursor);
  return page(
    `${repo} · world log`,
    `<h1>World log <span class="refchip">world</span></h1>
<p class="muted">Published states of ${esc(repo)}, newest first.</p>
${logTable(repo, entries)}
${nextLink(`/${esc(repo)}/world`, nextCursor)}`,
    { repo, tab: "world" },
  );
}

export async function renderStateDetail(client: JavelinClient, repo: string, idRaw: string): Promise<string> {
  const id = parseObjectId(idRaw);
  if (!id) throw new NotFound(`invalid state id: ${idRaw}`);
  const objects = await fetchObjects(client, repo, [id]);
  const state = asState(objects.get(id));
  if (!state) throw new NotFound(`state not found: ${id}`);
  const firstParent = state.parents[0];
  const filesHere = await flattenTree(client, repo, state.tree);
  let changed: string[];
  if (firstParent) {
    const parentObjects = await fetchObjects(client, repo, [firstParent]);
    const parentState = asState(parentObjects.get(firstParent));
    if (!parentState) throw new NotFound(`parent state not found: ${firstParent}`);
    changed = treeDiff(await flattenTree(client, repo, parentState.tree), filesHere);
  } else {
    changed = [...filesHere.keys()].sort();
  }
  const parentLinks =
    state.parents.map((p) => `<a href="${stateHref(repo, p)}"><code>${esc(short(p))}</code></a>`).join(", ") ||
    '<span class="muted">none (root state)</span>';
  const fileRows = changed
    .map((p) => {
      const file = filesHere.get(p);
      const href = file ? blobHref(repo, file.id, p) : "#";
      return `<tr><td><a href="${href}">${esc(p)}</a></td></tr>`;
    })
    .join("\n");
  return page(
    `${short(id)} · ${repo}`,
    `<h1><code>${esc(short(id))}</code> <span class="muted">state in ${esc(repo)}</span></h1>
<div class="card">
  <pre>${esc(state.message)}</pre>
  <p class="muted">${esc(state.author.name)} &lt;${esc(state.author.email)}&gt; &middot; ${esc(fmtTime(state.author.time))} &middot; parents: ${parentLinks}</p>
</div>
<div class="card"><h2>Changed files vs first parent (${changed.length})</h2>
<table class="list">${fileRows}</table>
</div>`,
    { repo, tab: "overview" },
  );
}

export async function renderLayers(client: JavelinClient, repo: string): Promise<string> {
  const heads = await client.getHeads(repo);
  const rows = heads.layers
    .map(
      (l) => `<tr>
  <td><a href="${layerLogHref(repo, l.name)}">${esc(l.name)}</a></td>
  <td>${shortId(repo, l.base)}</td>
  <td>${shortId(repo, l.head)}</td>
  <td class="muted">${esc(fmtTime(l.updatedAt))}</td>
  <td><a href="${browseHref(repo, `layer/${l.name}` as RefSpec)}">browse</a></td>
</tr>`,
    )
    .join("\n");
  return page(
    `${repo} · layers`,
    `<h1>Layers in ${esc(repo)}</h1>
<p class="muted">Layers are isolated lines of tentative work forked from a World state.</p>
${
  heads.layers.length === 0
    ? '<p class="muted">No layers yet.</p>'
    : `<table class="list"><tr><th>Name</th><th>Base</th><th>Head</th><th>Updated</th><th></th></tr>${rows}</table>`
}`,
    { repo, tab: "layers" },
  );
}

export async function renderLayerLog(client: JavelinClient, repo: string, name: string, cursor?: Cursor): Promise<string> {
  const heads = await client.getHeads(repo);
  const layer = heads.layers.find((l) => l.name === name);
  if (!layer) throw new NotFound(`layer not found: ${name}`);
  const start = layer.head ?? layer.base;
  const { entries, nextCursor } = await logPage(client, repo, start, cursor);
  return page(
    `${repo} · layer ${name}`,
    `<h1>Layer <span class="refchip">${esc(name)}</span> <span class="muted">in ${esc(repo)}</span></h1>
<p class="muted">Checkpoint chain; base ${shortId(repo, layer.base)}, head ${shortId(repo, layer.head)} &middot; <a href="${browseHref(repo, `layer/${name}` as RefSpec)}">Browse files</a></p>
${entries.length === 0 ? '<p class="muted">No checkpoints yet.</p>' : logTable(repo, entries)}
${nextLink(`${layerLogHref(repo, name)}`, nextCursor)}`,
    { repo, tab: "layers" },
  );
}

export async function renderBrowse(client: JavelinClient, repo: string, ref: RefSpec, segments: string[]): Promise<string> {
  const heads = await client.getHeads(repo);
  const stateId = refHead(heads, ref) ?? refBase(heads, ref);
  if (!stateId) throw new NotFound(`${ref} has no states yet`);
  const state = asState((await fetchObjects(client, repo, [stateId])).get(stateId));
  if (!state) throw new NotFound(`state not found: ${stateId}`);
  let current = state.tree;
  for (let i = 0; i < segments.length; i++) {
    const tree = asTree((await fetchObjects(client, repo, [current])).get(current));
    if (!tree) throw new NotFound(`path not found in ${repo}@${ref}`);
    const entry = tree.entries.find((e) => e.name === segments[i]!);
    if (!entry) throw new NotFound(`path not found in ${repo}@${ref}: ${segments.join("/")}`);
    current = entry.id;
    if (entry.kind === "blob") {
      const rest = segments.slice(i + 1);
      if (rest.length > 0) throw new NotFound(`path not found in ${repo}@${ref}: ${segments.join("/")}`);
      return blobView(client, repo, entry.id, segments, ref);
    }
  }
  const entries = asTree((await fetchObjects(client, repo, [current])).get(current))?.entries ?? [];
  const sorted = [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "tree" ? -1 : 1));
  const rows = sorted
    .map((e) => {
      const name = e.kind === "tree"
        ? `<a href="${browseHref(repo, ref, [...segments, e.name])}">${esc(e.name)}/</a>`
        : `<a href="${blobHref(repo, e.id, [...segments, e.name].join("/"))}">${esc(e.name)}</a>`;
      return `<tr><td>${e.kind === "tree" ? "dir" : "file"}</td><td>${name}</td><td><code class="muted">${esc(short(e.id))}</code></td></tr>`;
    })
    .join("\n");
  const crumb = segments.length
    ? `<p class="muted">${esc(ref)} / ${segments
        .map((s, i) => {
          const last = i === segments.length - 1;
          return last ? `<strong>${esc(s)}</strong>` : `<a href="${browseHref(repo, ref, segments.slice(0, i + 1))}">${esc(s)}</a>`;
        })
        .join(" / ")}</p>`
    : "";
  const up = segments.length ? `<tr><td></td><td colspan="2"><a href="${browseHref(repo, ref, segments.slice(0, -1))}">..</a></td></tr>` : "";
  return page(
    `${repo} · ${ref}`,
    `<h1>${esc(repo)} <span class="refchip">${esc(ref)}</span></h1>
${crumb}
<table class="list tree"><tr><th></th><th>Name</th><th>Object</th></tr>${up}${rows}</table>`,
    { repo, tab: ref === "world" ? "world" : "layers" },
  );
}

async function blobView(client: JavelinClient, repo: string, id: ObjectId, path: string[], ref: RefSpec): Promise<string> {
  const bytes = blobBytes((await fetchObjects(client, repo, [id])).get(id));
  if (!bytes) throw new NotFound(`blob not found: ${id}`);
  const displayPath = path.join("/") || id;
  const crumb = `<p class="muted">${esc(ref)} / ${path
    .map((s, i) => (i === path.length - 1 ? `<strong>${esc(s)}</strong>` : esc(s)))
    .join(" / ")}</p>`;
  const rawLink = `<p class="muted"><a href="/${esc(repo)}/raw/${esc(id)}">raw</a></p>`;
  if (isBinary(bytes)) {
    return page(
      `${displayPath} · ${repo}`,
      `<h1>${esc(displayPath)} <span class="muted">in ${esc(repo)}</span></h1>
${crumb}
<div class="card"><p>binary content, ${bytes.byteLength} bytes</p>${rawLink}</div>`,
      { repo, tab: ref === "world" ? "world" : "layers" },
    );
  }
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  const body = lines
    .map((line, i) => `<div class="line"><span class="ln">${i + 1}</span><span class="src">${esc(line)}</span></div>`)
    .join("\n");
  return page(
    `${displayPath} · ${repo}`,
    `<h1>${esc(displayPath)} <span class="muted">in ${esc(repo)}</span></h1>
${crumb}
<p class="muted">${lines.length} lines</p>
<div class="blob">${body}</div>
${rawLink}`,
    { repo, tab: ref === "world" ? "world" : "layers" },
  );
}

export async function renderBlob(client: JavelinClient, repo: string, idRaw: string, path: string[]): Promise<string> {
  const id = parseObjectId(idRaw);
  if (!id) throw new NotFound(`invalid object id: ${idRaw}`);
  return blobView(client, repo, id, path, "world");
}

export async function renderContributions(client: JavelinClient, repo: string, cursor?: Cursor): Promise<string> {
  const { contributions, nextCursor } = await client.listContributions(repo, cursor ? { cursor } : {});
  const rows = contributions
    .map(
      (c) => `<tr>
  <td><a href="/${esc(repo)}/contribution/${esc(c.id)}">${esc(c.title)}</a></td>
  <td><a href="${layerLogHref(repo, c.layer)}">${esc(c.layer)}</a></td>
  <td>${esc(c.author.name)}</td>
  <td class="muted">${esc(fmtTime(c.createdAt))}</td>
  <td>${statusBadge(c.status)}</td>
</tr>`,
    )
    .join("\n");
  return page(
    `${repo} · contributions`,
    `<h1>Contributions in ${esc(repo)}</h1>
<p class="muted">Proposals to publish a layer head into World.</p>
${
  contributions.length === 0
    ? '<p class="muted">No contributions yet.</p>'
    : `<table class="list"><tr><th>Title</th><th>Layer</th><th>Author</th><th>Created</th><th>Status</th></tr>${rows}</table>`
}
${nextLink(`/${esc(repo)}/contributions`, nextCursor)}`,
    { repo, tab: "contributions" },
  );
}

export async function renderContribution(client: JavelinClient, repo: string, idRaw: string): Promise<string> {
  const id = parseObjectId(idRaw);
  if (!id) throw new NotFound(`invalid contribution id: ${idRaw}`);
  const listed = await client.listContributions(repo, {});
  const withStatus = listed.contributions.find((c) => c.id === id);
  if (!withStatus) throw new NotFound(`contribution not found: ${id}`);
  const contribution = asContribution((await fetchObjects(client, repo, [id])).get(id));
  if (!contribution) throw new NotFound(`contribution not found: ${id}`);
  const actions =
    withStatus.status === "open"
      ? `<form class="inline" method="post" action="/${esc(repo)}/contribution/${esc(id)}/publish">
  <button type="submit" class="primary">Publish to World</button>
</form>
<form class="inline" method="post" action="/${esc(repo)}/contribution/${esc(id)}/discard">
  <button type="submit" class="danger">Discard</button>
</form>`
      : `<p class="muted">This contribution is ${esc(withStatus.status)}; the decision is final.</p>`;
  const timeline = `<ul class="timeline">
  <li>opened by ${esc(contribution.author.name)} &middot; ${esc(fmtTime(contribution.createdAt))}</li>
  <li>status: ${statusBadge(withStatus.status)}</li>
</ul>`;
  return page(
    `${contribution.title} · ${repo}`,
    `<h1>${esc(contribution.title)}</h1>
<div class="card">
  <p>Proposes publishing layer <a href="${layerLogHref(repo, contribution.layer)}">${esc(contribution.layer)}</a> head
  <a href="${stateHref(repo, contribution.state)}"><code>${esc(short(contribution.state))}</code></a>
  (forked from base <a href="${stateHref(repo, contribution.base)}"><code>${esc(short(contribution.base))}</code></a>) into World.</p>
  <p class="muted">proposed by ${esc(contribution.author.name)} &lt;${esc(contribution.author.email)}&gt; &middot; ${esc(fmtTime(contribution.createdAt))}</p>
</div>
<div class="card"><h2>Timeline</h2>${timeline}</div>
<div class="card"><h2>Decide</h2>${actions}</div>`,
    { repo, tab: "contributions" },
  );
}

const SEARCH_KINDS = ["code", "history", "provenance"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export function parseSearchKind(value: string | null): SearchKind {
  return (SEARCH_KINDS as readonly string[]).includes(value ?? "") ? (value as SearchKind) : "code";
}

function hitHtml(repo: string, h: SearchResult): string {
  if (h.kind === "code") {
    return `<div class="hit">
  <a href="${blobHref(repo, h.blob, h.path)}">${esc(h.path)}</a>
  ${h.snippet ? `<pre>${esc(h.snippet)}</pre>` : ""}
</div>`;
  }
  if (h.kind === "history") {
    return `<div class="hit">
  <a href="${stateHref(repo, h.state)}"><code>${esc(short(h.state))}</code></a>
  <pre>${esc(h.snippet)}</pre>
</div>`;
  }
  return `<div class="hit">
  <span class="refchip">provenance ${esc(short(h.record))}</span>
  <pre>${esc(h.snippet)}</pre>
</div>`;
}

export async function renderSearch(
  client: JavelinClient,
  repo: string,
  query: string,
  kind: SearchKind,
  cursor?: Cursor,
): Promise<string> {
  let results: RepoSearchResponse = { hits: [] };
  let error: string | null = null;
  if (query) {
    try {
      results = await client.search(repo, { query, kind, ...(cursor ? { cursor } : {}) });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const hits = results.hits.map((h) => hitHtml(repo, h)).join("\n");
  const kindOptions = SEARCH_KINDS.map((k) => `<option value="${k}"${k === kind ? " selected" : ""}>${k}</option>`).join("");
  return page(
    `Search ${repo}`,
    `<h1>Search in ${esc(repo)}</h1>
<form class="inline" method="get" action="/${esc(repo)}/search">
  <input type="text" name="q" value="${esc(query)}" placeholder="Search ${esc(repo)}…">
  <select name="kind">${kindOptions}</select>
  <button type="submit">Search</button>
</form>
${error ? `<div class="error"><p>${esc(error)}</p></div>` : ""}
${query ? `<p class="muted">${results.hits.length} match${results.hits.length === 1 ? "" : "es"} for “${esc(query)}” (${esc(kind)})</p>${hits || '<p class="muted">No matches.</p>'}${nextLink(`/${esc(repo)}/search?q=${encodeURIComponent(query)}&kind=${kind}`, results.nextCursor)}` : ""}`,
    { repo, tab: "search" },
  );
}
