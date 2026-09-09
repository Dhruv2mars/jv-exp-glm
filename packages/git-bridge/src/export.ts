import { mkdir } from "node:fs/promises";
import type { ObjectId } from "@javelin/protocol";
import { openRepository, type FileEntry, type Repository } from "@javelin/vcs";
import type { FileMode } from "@javelin/protocol";
import { formatGitPerson, git } from "./git";
import { writeMirrorMarker, type MirrorMode } from "./bridge";

export interface ExportOptions {
  /** ADR 0009 mode recorded in the mirror marker; export defaults to native (Javelin authoritative). */
  mode?: MirrorMode;
}

export interface ExportResult {
  commits: number;
  refs: Record<string, string>;
  worldHead: ObjectId | null;
  warnings: string[];
}

const GIT_MODES: Record<FileMode, string> = {
  file: "100644",
  exec: "100755",
  symlink: "120000",
};

/**
 * Write the Javelin world chain plus every layer into a real git repo via fast-import:
 * world head -> refs/heads/main, layer heads -> refs/heads/<layer>. Symlinks and exec
 * bits are recreated from tree entry modes. Tags are not exported; Javelin v2 has no
 * tag object (they survive only as bridge-map metadata).
 */
export async function exportToGit(
  jvlRepoPath: string,
  gitRepoPath: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const repo = await openRepository(jvlRepoPath);
  const warnings: string[] = [];
  const world = await repo.worldHead();

  const layerRefs = [];
  for (const ref of await repo.layerList()) {
    if (!ref.head) warnings.push(`skipping layer ${ref.name}: no checkpoints`);
    else layerRefs.push(ref);
  }

  const roots = [...new Set([world, ...layerRefs.map((r) => r.head!)].filter((id): id is ObjectId => id !== null))];
  const refs: Record<string, string> = {};
  let order: ObjectId[] = [];

  if (roots.length > 0) {
    order = await topoOrder(repo, roots);
    const marks = new Map<ObjectId, number>();
    const chunks: Uint8Array[] = [];
    const enc = new TextEncoder();
    let nextMark = 1;
    const push = (s: string) => chunks.push(enc.encode(s));
    const pushData = (bytes: Uint8Array) => {
      push(`data ${bytes.length}\n`);
      chunks.push(bytes);
      push("\n");
    };

    for (const id of order) {
      const state = await repo.loadState(id);
      const mark = nextMark++;
      marks.set(id, mark);
      const person = formatGitPerson(state.author);
      push(`commit refs/heads/__javelin_tmp\nmark :${mark}\nauthor ${person}\ncommitter ${person}\n`);
      pushData(enc.encode(state.message));
      state.parents.forEach((parent, i) => push(`${i === 0 ? "from" : "merge"} :${marks.get(parent)}\n`));
      push("deleteall\n");
      const files = await flattenTree(repo, state.tree);
      for (const path of Object.keys(files).sort()) {
        const entry = files[path]!;
        push(`M ${GIT_MODES[entry.mode]} inline ${path}\n`);
        pushData(await repo.readBlob(entry.id));
      }
      push("\n");
    }

    if (world) {
      push(`reset refs/heads/main\nfrom :${marks.get(world)}\n\n`);
      refs["refs/heads/main"] = world;
    }
    for (const ref of layerRefs) {
      push(`reset refs/heads/${ref.name}\nfrom :${marks.get(ref.head!)}\n\n`);
      refs[`refs/heads/${ref.name}`] = ref.head!;
    }

    await mkdir(gitRepoPath, { recursive: true });
    const existing = await Array.fromAsync(new Bun.Glob(".git*").scan({ cwd: gitRepoPath, onlyFiles: false }));
    if (!existing.some((n) => n.startsWith(".git"))) await git(["init", "-q"], gitRepoPath);

    const proc = Bun.spawn(["git", "fast-import", "--quiet", "--done"], {
      cwd: gitRepoPath,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    for (const chunk of chunks) proc.stdin.write(chunk);
    proc.stdin.write(enc.encode("done\n"));
    proc.stdin.end();
    const err = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(`git fast-import failed: ${err.trim()}`);
    await git(["update-ref", "-d", "refs/heads/__javelin_tmp"], gitRepoPath);
    if (world) await git(["symbolic-ref", "HEAD", "refs/heads/main"], gitRepoPath);
  }

  await writeMirrorMarker(jvlRepoPath, opts.mode ?? "native", "javelin");
  return { commits: order.length, refs, worldHead: world, warnings };
}

async function topoOrder(repo: Repository, roots: ObjectId[]): Promise<ObjectId[]> {
  const seen = new Set<string>();
  const order: ObjectId[] = [];
  const visit = async (id: ObjectId): Promise<void> => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const parent of (await repo.loadState(id)).parents) await visit(parent);
    order.push(id);
  };
  for (const root of roots) await visit(root);
  return order;
}

async function flattenTree(repo: Repository, treeId: ObjectId): Promise<Record<string, FileEntry>> {
  const files: Record<string, FileEntry> = {};
  const walk = async (id: ObjectId, dir: string): Promise<void> => {
    for (const entry of (await repo.loadTree(id)).entries) {
      const full = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === "tree") await walk(entry.id, full);
      else files[full] = { id: entry.id, mode: entry.mode };
    }
  };
  await walk(treeId, "");
  return files;
}
