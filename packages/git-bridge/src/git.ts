export interface GitPerson {
  name: string;
  email: string;
  time: string;
}

export interface GitCommitParsed {
  tree: string;
  parents: string[];
  author: GitPerson;
  committer: GitPerson;
  message: string;
}

export interface GitTagParsed {
  object: string;
  name: string;
  tagger: GitPerson;
  message: string;
}

export interface GitFileInfo {
  path: string;
  mode: string;
  hash: string;
}

export async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`);
  return out;
}

export async function gitBinary(args: string[], cwd?: string): Promise<Uint8Array> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`);
  return new Uint8Array(out);
}

/** "Name <email> 1234567890 +0530" -> GitPerson with ISO UTC time. */
export function parseGitPerson(raw: string): GitPerson {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
  if (!m) throw new Error(`unparseable git person field: ${raw}`);
  const epochMs = Number(m[3]) * 1000;
  return { name: m[1]!, email: m[2]!, time: new Date(epochMs).toISOString() };
}

/** GitPerson -> "Name <email> epoch +0000" for fast-import. */
export function formatGitPerson(p: GitPerson): string {
  const epoch = Math.floor(new Date(p.time).getTime() / 1000);
  return `${p.name} <${p.email}> ${epoch} +0000`;
}

export function parseCommitObject(raw: string): GitCommitParsed {
  const headerEnd = raw.indexOf("\n\n");
  const header = raw.slice(0, headerEnd === -1 ? raw.length : headerEnd);
  const message = headerEnd === -1 ? "" : raw.slice(headerEnd + 2);
  let tree = "";
  const parents: string[] = [];
  let author: GitPerson | null = null;
  let committer: GitPerson | null = null;
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = parseGitPerson(line.slice(7));
    else if (line.startsWith("committer ")) committer = parseGitPerson(line.slice(10));
  }
  if (!tree || !author || !committer) throw new Error(`unparseable git commit object`);
  return { tree, parents, author, committer, message };
}

export function parseTagObject(raw: string): GitTagParsed {
  const headerEnd = raw.indexOf("\n\n");
  const header = raw.slice(0, headerEnd === -1 ? raw.length : headerEnd);
  const message = headerEnd === -1 ? "" : raw.slice(headerEnd + 2);
  let object = "";
  let name = "";
  let tagger: GitPerson | null = null;
  for (const line of header.split("\n")) {
    if (line.startsWith("object ")) object = line.slice(7);
    else if (line.startsWith("tag ")) name = line.slice(4);
    else if (line.startsWith("tagger ")) tagger = parseGitPerson(line.slice(7));
  }
  if (!object || !name || !tagger) throw new Error(`unparseable git tag object`);
  return { object, name, tagger, message };
}

/** Parse `git ls-tree -r -z` output into flat file records. */
export function parseLsTree(raw: Uint8Array): GitFileInfo[] {
  const text = new TextDecoder().decode(raw);
  const out: GitFileInfo[] = [];
  for (const record of text.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const meta = record.slice(0, tab);
    const path = record.slice(tab + 1);
    const [mode, , hash] = meta.split(" ");
    if (!mode || !hash) throw new Error(`unparseable ls-tree record: ${record}`);
    out.push({ path, mode, hash });
  }
  return out;
}
