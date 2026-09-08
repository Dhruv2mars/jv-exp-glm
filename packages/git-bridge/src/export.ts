import { mkdir } from "node:fs/promises";
import type { ObjectId } from "@javelin/protocol";
import { openRepository, type Repository } from "@javelin/vcs";
import { formatGitPerson, git } from "./git";
import { loadExecSet } from "./import";

export interface ExportResult {
  commits: number;
  refs: Record<string, string>;
  warnings: string[];
}

export async function exportToGit(jvlRepoPath: string, gitRepoPath: string): Promise<ExportResult> {
  const repo = await openRepository(jvlRepoPath);
  const warnings: string[] = [];

  const allRefs = await repo.refs.list();
  const refs = Object.entries(allRefs).filter(([ref]) => ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/"));
  if (refs.length === 0) return { commits: 0, refs: {}, warnings };

  const commitIds = new Set<ObjectId>();
  for (const [ref, id] of refs) {
    const obj = await repo.objects.read(id);
    if (!obj) throw new Error(`missing object for ref ${ref}`);
    if (obj.kind === "commit") commitIds.add(id);
    else if (obj.kind === "tag") {
      const target = await repo.objects.read(obj.target);
      if (target?.kind === "commit") commitIds.add(obj.target);
    } else warnings.push(`skipping ${ref}: unsupported object kind ${obj.kind}`);
  }

  const jvlToMark = new Map<ObjectId, number>();
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  const push = (s: string) => chunks.push(enc.encode(s));
  const pushData = (bytes: Uint8Array) => {
    push(`data ${bytes.length}\n`);
    chunks.push(bytes);
    push("\n");
  };
  let nextMark = 1;

  const order = await topoOrder(repo, [...commitIds]);
  for (const commitId of order) {
    const commit = await repo.loadCommit(commitId);
    const flat = await repo.readCommitTree(commitId);
    const mark = nextMark++;
    jvlToMark.set(commitId, mark);
    push(`commit refs/heads/__javelin_tmp\n`);
    push(`mark :${mark}\n`);
    push(`author ${formatGitPerson(commit.author)}\n`);
    push(`committer ${formatGitPerson(commit.committer)}\n`);
    pushData(new TextEncoder().encode(commit.message));
    const parentMarks = commit.parents.map((p) => jvlToMark.get(p)).filter((m) => m !== undefined);
    if (parentMarks.length > 0) push(`from :${parentMarks[0]}\n`);
    for (const m of parentMarks.slice(1)) push(`merge :${m}\n`);
    push(`deleteall\n`);
    const execSet = await loadExecSet(jvlRepoPath);
    for (const [path, blobId] of Object.entries(flat)) {
      const mode = execSet.has(blobId) ? "100755" : "100644";
      push(`M ${mode} inline ${path}\n`);
      pushData(await repo.readBlob(blobId));
    }
    push(`\n`);
  }

  const finalRefs: Record<string, string> = {};
  for (const [ref, id] of refs) {
    const obj = (await repo.objects.read(id))!;
    let markSource: ObjectId | null = null;
    if (obj.kind === "commit") markSource = id;
    else if (obj.kind === "tag") markSource = obj.target;
    const mark = markSource ? jvlToMark.get(markSource) : undefined;
    if (mark === undefined) continue;
    if (ref.startsWith("refs/heads/")) {
      push(`reset ${ref}\nfrom :${mark}\n\n`);
    } else if (obj.kind === "tag") {
      push(`tag ${obj.name}\nfrom :${mark}\ntagger ${formatGitPerson(obj.tagger)}\n`);
      pushData(new TextEncoder().encode(obj.message));
    } else {
      push(`reset ${ref}\nfrom :${mark}\n\n`);
    }
    finalRefs[ref] = id;
  }

  await mkdir(gitRepoPath, { recursive: true });
  const existing = await Array.fromAsync(new Bun.Glob(".git*").scan({ cwd: gitRepoPath, onlyFiles: false }));
  if (!existing.some((n) => n.startsWith(".git"))) await git(["init", "-q"], gitRepoPath);

  const proc = Bun.spawn(["git", "fast-import", "--quiet", "--done"], { cwd: gitRepoPath, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  for (const chunk of chunks) proc.stdin.write(chunk);
  proc.stdin.write(enc.encode("done\n"));
  proc.stdin.end();
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`git fast-import failed: ${err.trim()}`);
  await git(["update-ref", "-d", "refs/heads/__javelin_tmp"], gitRepoPath);

  return { commits: order.length, refs: finalRefs, warnings };
}

async function topoOrder(repo: Repository, roots: ObjectId[]): Promise<ObjectId[]> {
  const seen = new Set<string>();
  const order: ObjectId[] = [];
  const visit = async (id: ObjectId, stack: Set<string>): Promise<void> => {
    if (seen.has(id) || stack.has(id)) return;
    stack.add(id);
    const commit = await repo.loadCommit(id);
    for (const parent of commit.parents) await visit(parent, stack);
    stack.delete(id);
    seen.add(id);
    order.push(id);
  };
  for (const root of roots) await visit(root, new Set());
  return order;
}
