import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ObjectId } from "@javelin/protocol";
import { encodeObject, hashEncoding, openRepository, type DiffEntry, type Repository } from "@javelin/vcs";

export async function cmdInit(dir = "."): Promise<string> {
  const root = join(process.cwd(), dir);
  await openRepository(root);
  return `initialized javelin repository in ${root}`;
}

export async function cmdStatus(root: string): Promise<string> {
  const repo = await openRepository(root);
  const branch = await repo.currentBranch();
  const head = await repo.refs.get(`refs/heads/${branch}`);
  const index = await repo.readIndex();
  const headFiles = head ? await repo.readCommitTree(head) : {};
  const lines = [`on branch ${branch}${head ? "" : " (no commits yet)"}`];
  const paths = [...new Set([...Object.keys(headFiles), ...Object.keys(index)])].sort();
  const staged: DiffEntry[] = [];
  for (const path of paths) {
    const oldId = headFiles[path] ?? null;
    const newId = index[path] ?? null;
    if (oldId === newId) continue;
    const status = !oldId ? "added" : !newId ? "deleted" : "modified";
    staged.push({ path, status, oldId, newId });
    lines.push(`  staged:  ${status}  ${path}`);
  }
  const untracked = await scanUntracked(root, new Set([...Object.keys(headFiles), ...Object.keys(index)]));
  for (const path of untracked) lines.push(`  untracked: ${path}`);
  if (staged.length === 0 && untracked.length === 0) lines.push("nothing to commit, working tree clean");
  return lines.join("\n");
}

async function scanUntracked(root: string, known: Set<string>): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set([".javelin", "node_modules", ".git"]);
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (skip.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const rel = relative(root, full);
        if (!known.has(rel)) out.push(rel);
      }
    }
  };
  await walk(root);
  return out;
}

export async function cmdAdd(root: string, paths: string[]): Promise<string> {
  if (paths.length === 0) throw new Error("nothing specified to add");
  const repo = await openRepository(root);
  let count = 0;
  for (const p of paths) {
    const abs = join(root, p);
    const s = await stat(abs);
    if (s.isDirectory()) {
      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (e.name === ".javelin" || e.name === "node_modules") continue;
          const child = join(dir, e.name);
          if (e.isDirectory()) await walk(child);
          else if (e.isFile()) files.push(child);
        }
      };
      await walk(abs);
      for (const f of files) {
        await repo.stage(relative(root, f), new Uint8Array(await readFile(f)));
        count++;
      }
    } else if (s.isFile()) {
      await repo.stage(relative(root, abs), new Uint8Array(await readFile(abs)));
      count++;
    } else {
      throw new Error(`not a file or directory: ${p}`);
    }
  }
  return `staged ${count} file${count === 1 ? "" : "s"}`;
}

export async function cmdCommit(root: string, message: string): Promise<string> {
  if (!message) throw new Error("commit message required (-m <msg>)");
  const repo = await openRepository(root);
  const id = await repo.commit({ message });
  return `[${await repo.currentBranch()} ${id}] ${message}`;
}

export async function cmdLog(root: string, limit = 100): Promise<string> {
  const repo = await openRepository(root);
  const branch = await repo.currentBranch();
  const entries = await repo.log(`refs/heads/${branch}`, limit);
  if (entries.length === 0) return "no commits yet";
  return entries
    .map((e) => `commit ${e.id}\nauthor ${e.commit.author.name} <${e.commit.author.email}> ${e.commit.author.time}\n\n    ${e.commit.message.split("\n").join("\n    ")}`)
    .join("\n\n");
}

export async function cmdDiff(root: string, ref?: string): Promise<string> {
  const repo = await openRepository(root);
  const branch = await repo.currentBranch();
  const head = await repo.refs.get(`refs/heads/${branch}`);
  let entries: DiffEntry[];
  if (ref) {
    entries = await repo.diff(ref, head ?? branch);
  } else if (head) {
    const headFiles = await repo.readCommitTree(head);
    const workFiles = await workingTreeFlat(repo, headFiles);
    entries = diffFlat(headFiles, workFiles);
  } else {
    entries = [];
  }
  if (entries.length === 0) return "no changes";
  return entries.map((e) => `${e.status.padEnd(9)} ${e.path}`).join("\n");
}

async function workingTreeFlat(repo: Repository, known: Record<string, ObjectId>): Promise<Record<string, ObjectId>> {
  const out: Record<string, ObjectId> = {};
  for (const path of Object.keys(known)) {
    const data = await readFileBytes(repo.root, path);
    if (data === null) continue;
    out[path] = await hashEncoding(encodeObject({ kind: "blob", data }));
  }
  return out;
}

async function readFileBytes(root: string, path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(root, path)));
  } catch {
    return null;
  }
}

function diffFlat(a: Record<string, ObjectId>, b: Record<string, ObjectId>): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const oldId = a[path] ?? null;
    const newId = b[path] ?? null;
    if (oldId === newId) continue;
    if (!oldId) out.push({ path, status: "added", oldId, newId });
    else if (!newId) out.push({ path, status: "deleted", oldId, newId });
    else out.push({ path, status: "modified", oldId, newId });
  }
  return out;
}

export async function cmdBranch(root: string, name?: string): Promise<string> {
  const repo = await openRepository(root);
  if (name === undefined) {
    const current = await repo.currentBranch();
    const branches = await repo.listBranches();
    if (branches.length === 0) return `(no branches yet)`;
    return branches.map((b) => `${b.name === current ? "* " : "  "}${b.name}`).join("\n");
  }
  const result = await repo.createBranch(name);
  if (!result.ok) throw new Error(`failed to create branch ${name}: ${result.detail ?? result.reason}`);
  return `created branch ${name}`;
}

export async function cmdCheckout(root: string, target: string): Promise<string> {
  const repo = await openRepository(root);
  await repo.checkout(target);
  const branch = await repo.currentBranch();
  return branch === target ? `switched to branch '${target}'` : `checked out '${target}' (detached from ${branch})`;
}

export async function cmdMerge(root: string, ref: string): Promise<string> {
  const repo = await openRepository(root);
  const result = await repo.mergeBranch(ref);
  if (!result.ok) {
    const details = result.conflicts.map((c) => `  conflict: ${c.path}`).join("\n");
    throw new Error(`merge failed with ${result.conflicts.length} conflict(s):\n${details}`);
  }
  if (result.commitId === null) throw new Error(`merge of ${ref} produced no commit`);
  const commit = await repo.loadCommit(result.commitId);
  return commit.parents.length > 1 ? `merged ${ref} as ${result.commitId}` : `already up to date`;
}

export async function requireRepo(root: string): Promise<Repository> {
  const repo = await openRepository(root);
  return repo;
}
