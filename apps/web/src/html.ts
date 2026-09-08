const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

export function page(title: string, body: string, repoNav?: { repo: string; tab: string }): string {
  const nav = repoNav
    ? `<nav class="tabs">${tabs(repoNav.repo, repoNav.tab)}</nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Javelin</title>
<style>
  :root { --border: #d0d7de; --muted: #656d76; --accent: #0969da; --bg: #ffffff; --soft: #f6f8fa; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2328; background: var(--bg); line-height: 1.5; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header.top { background: #0d1117; color: #f0f6fc; padding: 0.7rem 1.5rem; display: flex; align-items: center; gap: 0.75rem; }
  header.top a { color: #f0f6fc; font-weight: 600; font-size: 1.05rem; }
  header.top .crumb { color: #8b949e; font-size: 0.85rem; }
  main { max-width: 980px; margin: 0 auto; padding: 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0.2rem 0 1rem; }
  nav.tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border); margin-bottom: 1.25rem; }
  nav.tabs a { padding: 0.45rem 0.9rem; color: var(--muted); border-bottom: 2px solid transparent; }
  nav.tabs a.active { color: #1f2328; font-weight: 600; border-bottom-color: #fd8c73; }
  table.list { width: 100%; border-collapse: collapse; }
  table.list td, table.list th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); }
  table.list th { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  code, pre { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 0.86rem; }
  .muted { color: var(--muted); font-size: 0.88rem; }
  .card { border: 1px solid var(--border); border-radius: 6px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
  .card h2 { margin: 0 0 0.75rem; font-size: 1rem; }
  .tree td:first-child { width: 1.6rem; color: var(--muted); }
  .blob { border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; }
  .blob .line { display: flex; }
  .blob .line:nth-child(odd) { background: var(--soft); }
  .blob .ln { flex: 0 0 3.2rem; text-align: right; padding: 0.06rem 0.6rem; color: #8c959f; user-select: none; }
  .blob .src { padding: 0.06rem 0.75rem; white-space: pre; }
  input[type=text] { padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; }
  button { padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--soft); font-size: 0.9rem; cursor: pointer; }
  button:hover { background: #eef1f4; }
  form.inline { display: flex; gap: 0.5rem; margin: 0.75rem 0; }
  .error { text-align: center; padding: 4rem 0; }
  .error .code { font-size: 4rem; font-weight: 700; color: var(--muted); }
  .hit { margin-bottom: 1rem; }
  .hit pre { background: var(--soft); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.75rem; margin: 0.25rem 0 0; overflow-x: auto; }
  .refchip { display: inline-block; background: #ddf4ff; color: var(--accent); border-radius: 999px; padding: 0.05rem 0.6rem; font-size: 0.8rem; }
</style>
</head>
<body>
<header class="top"><a href="/">Javelin</a><span class="crumb">hosted forge</span></header>
<main>
${nav}
${body}
</main>
</body>
</html>`;
}

function tabs(repo: string, active: string): string {
  const item = (tab: string, label: string, href: string) =>
    `<a href="${href}"${tab === active ? ' class="active"' : ""}>${label}</a>`;
  return [
    item("code", "Code", `/${esc(repo)}`),
    item("commits", "Commits", `/${esc(repo)}/commits`),
    item("search", "Search", `/${esc(repo)}/search`),
  ].join("");
}

export function notFound(message: string): string {
  return page("Not found", `<div class="error"><div class="code">404</div><p>${esc(message)}</p><p><a href="/">Back to repositories</a></p></div>`);
}
