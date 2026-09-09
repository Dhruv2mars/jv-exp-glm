import type { ObjectId } from "@javelin/protocol";
import { openRepository, makeTree, type BlobObject } from "@javelin/vcs";
import type { FileMode, LayerRef, State, TreeEntry } from "../../protocol/src/model";
import { git, gitBinary, parseCommitObject, parseLsTree, parseTagObject } from "./git";
import { loadBridgeMap, saveBridgeMap, writeMirrorMarker, type MirrorMode } from "./bridge";

export interface ImportOptions {
  /** ADR 0009 mode recorded in the mirror marker; import defaults to adoption (GitHub authoritative). */
  mode?: MirrorMode;
  /** Mainline branch name; defaults to the git repo's HEAD branch. */
  mainline?: string;
}

export interface ImportCounts {
  /** States written by this run (0 on a no-op re-import). */
  imported: number;
  /** Total git commits now mapped to javelin states. */
  states: number;
  /** Unique git blobs written by this run. */
  blobs: number;
  branches: number;
}

export interface ImportReport {
  worldHead: ObjectId | null;
  layers: LayerRef[];
  tags: Record<string, ObjectId>;
  counts: ImportCounts;
  warnings: string[];
}

const GIT_FILE_MODES: Record<string, FileMode> = {
  "100644": "file",
  "100755": "exec",
  "120000": "symlink",
};

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Import a git repo into the Javelin v2 model: the mainline commit chain becomes the
 * World chain ending at the world head (set via the vcs meta CAS), every other branch
 * becomes a layer based at the world state of its branch point (git merge-base), and
 * annotated tags are kept as bridge metadata. Incremental: commits already present in
 * .javelin/bridge-map.json are skipped, so re-importing after new upstream commits
 * imports only the new commits and a second run with no new commits is a no-op.
 */
export async function importFromGit(
  gitRepoPath: string,
  jvlRepoPath: string,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const repo = await openRepository(jvlRepoPath);
  const warnings: string[] = [];
  const mode = opts.mode ?? "adoption";
  const mainline = opts.mainline ?? (await git(["symbolic-ref", "--short", "HEAD"], gitRepoPath)).trim();

  const tips = new Map<string, string>();
  for (const ref of (await git(["for-each-ref", "--format=%(refname)", "refs/heads"], gitRepoPath)).split("\n").filter(Boolean)) {
    tips.set(ref.slice("refs/heads/".length), (await git(["rev-parse", ref], gitRepoPath)).trim());
  }
  const mainlineSha = tips.get(mainline) ?? null;

  const tagTargets = new Map<string, string>();
  for (const ref of (await git(["for-each-ref", "--format=%(refname) %(objecttype)", "refs/tags"], gitRepoPath)).split("\n").filter(Boolean)) {
    const [refName, type] = ref.split(" ");
    const name = refName!.slice("refs/tags/".length);
    if (type === "tag") {
      tagTargets.set(name, parseTagObject(await git(["cat-file", "tag", refName!], gitRepoPath)).object);
    } else if (type === "commit") {
      tagTargets.set(name, (await git(["rev-parse", refName!], gitRepoPath)).trim());
    } else {
      warnings.push(`skipping tag ${name}: unsupported target type ${type}`);
    }
  }

  if (tips.size === 0) {
    await writeMirrorMarker(jvlRepoPath, mode, "github");
    return {
      worldHead: null,
      layers: await repo.layerList(),
      tags: {},
      counts: { imported: 0, states: 0, blobs: 0, branches: 0 },
      warnings,
    };
  }

  const tipShas = [...new Set([...tips.values(), ...tagTargets.values()])];
  const order = (await git(["rev-list", "--topo-order", "--reverse", ...tipShas], gitRepoPath))
    .split("\n")
    .filter(Boolean);

  const map = await loadBridgeMap(jvlRepoPath);
  const shaToState = new Map<string, ObjectId>(Object.entries(map.commits));
  const blobIds = new Map<string, ObjectId>();
  let imported = 0;
  let blobCount = 0;

  for (const sha of order) {
    if (shaToState.has(sha)) continue;
    const raw = parseCommitObject(await git(["cat-file", "commit", sha], gitRepoPath));
    const treeId = await importTree(repo, gitRepoPath, sha, raw.tree, blobIds, () => blobCount++, warnings);
    const state: State = {
      kind: "state",
      tree: treeId,
      parents: raw.parents.map((p) => {
        const mapped = shaToState.get(p);
        if (!mapped) throw new Error(`parent ${p} of ${sha} not imported yet; rev-list order broken`);
        return mapped;
      }),
      author: { name: raw.author.name, email: raw.author.email, time: raw.author.time },
      message: raw.message,
    };
    shaToState.set(sha, (await repo.objects.write(state)).id);
    imported++;
  }

  let worldHead: ObjectId | null = mainlineSha ? (shaToState.get(mainlineSha) ?? null) : null;
  if (worldHead) {
    const raw = await repo.meta.get("world");
    const next = JSON.stringify({ value: worldHead });
    if (raw !== next && !(await repo.meta.compareAndSwap("world", raw, next)).ok) {
      warnings.push("world head moved during import; world head not updated");
    }
  }

  let branches = 0;
  for (const [name, tipSha] of tips) {
    if (name === mainline) continue;
    branches++;
    if (!KEY_RE.test(name) || name.includes("..")) {
      warnings.push(`skipping layer ${name}: unsupported layer name`);
      continue;
    }
    const head = shaToState.get(tipSha)!;
    const existing = await repo.layerGet(name);
    if (existing) {
      if (existing.head !== head) {
        const raw = await repo.meta.get(`layer/${name}`);
        const next = JSON.stringify({ ...existing, head, updatedAt: new Date().toISOString() });
        if (!(await repo.meta.compareAndSwap(`layer/${name}`, raw, next)).ok) {
          warnings.push(`layer ${name} moved during import; head not updated`);
        }
      }
      continue;
    }
    let base: ObjectId | null = null;
    try {
      base = shaToState.get((await git(["merge-base", mainlineSha!, tipSha], gitRepoPath)).trim()) ?? null;
    } catch {
      warnings.push(`skipping layer ${name}: no common ancestor with ${mainline}`);
      continue;
    }
    if (!base) {
      warnings.push(`skipping layer ${name}: branch point not imported`);
      continue;
    }
    const ref: LayerRef = { name, base, head, updatedAt: new Date().toISOString() };
    if (!(await repo.meta.create(`layer/${name}`, JSON.stringify(ref)))) {
      warnings.push(`layer ${name} already existed; not created`);
    }
  }

  const tags: Record<string, ObjectId> = {};
  for (const [name, sha] of tagTargets) {
    const state = shaToState.get(sha);
    if (state) tags[name] = state;
    else warnings.push(`tag ${name} points at an unimported commit`);
  }

  await saveBridgeMap(jvlRepoPath, { commits: Object.fromEntries(shaToState), tags });
  await writeMirrorMarker(jvlRepoPath, mode, "github");

  return {
    worldHead,
    layers: await repo.layerList(),
    tags,
    counts: { imported, states: shaToState.size, blobs: blobCount, branches },
    warnings,
  };
}

type Dir = Map<string, Dir | TreeEntry>;

async function importTree(
  repo: Awaited<ReturnType<typeof openRepository>>,
  gitRepoPath: string,
  sha: string,
  gitTree: string,
  blobIds: Map<string, ObjectId>,
  countBlob: () => void,
  warnings: string[],
): Promise<ObjectId> {
  const root: Dir = new Map();
  const files = parseLsTree(await gitBinary(["ls-tree", "-r", "-z", gitTree], gitRepoPath));
  for (const file of files) {
    const fileMode = GIT_FILE_MODES[file.mode];
    if (!fileMode) {
      warnings.push(`skipping ${file.path} in ${sha}: unsupported mode ${file.mode}`);
      continue;
    }
    let blobId = blobIds.get(file.hash);
    if (!blobId) {
      const blob: BlobObject = { kind: "blob", data: await gitBinary(["cat-file", "blob", file.hash], gitRepoPath) };
      blobId = (await repo.objects.write(blob)).id;
      blobIds.set(file.hash, blobId);
      countBlob();
    }
    const parts = file.path.split("/");
    const name = parts[parts.length - 1]!;
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.get(part);
      if (!(next instanceof Map)) {
        next = new Map();
        dir.set(part, next);
      }
      dir = next;
    }
    dir.set(name, { name, mode: fileMode, kind: "blob", id: blobId });
  }
  const writeDir = async (dir: Dir): Promise<ObjectId> => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of [...dir.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (value instanceof Map) entries.push({ name, mode: "file", kind: "tree", id: await writeDir(value) });
      else entries.push(value);
    }
    return (await repo.objects.write(makeTree(entries))).id;
  };
  return writeDir(root);
}
