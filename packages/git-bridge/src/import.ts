import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectId, RefName } from "@javelin/protocol";
import { objectId } from "@javelin/protocol";
import { makeTree, type BlobObject, type Repository } from "@javelin/vcs";
import {
  git,
  gitBinary,
  parseCommitObject,
  parseLsTree,
  parseTagObject,
  type GitCommitParsed,
} from "./git";

export interface ImportOptions {
  /** Git refs to import; defaults to refs/heads/* and refs/tags/*. */
  refs?: string[];
}

export interface ImportResult {
  commits: number;
  blobs: number;
  refs: Record<RefName, ObjectId>;
  warnings: string[];
}

const EXEC_SIDECAR = join(".javelin", "git-bridge", "exec.json");

export async function loadExecSet(jvlRoot: string): Promise<Set<ObjectId>> {
  try {
    const raw = JSON.parse(await readFile(join(jvlRoot, EXEC_SIDECAR), "utf8")) as string[];
    return new Set(raw.map(objectId));
  } catch {
    return new Set();
  }
}

export async function saveExecSet(jvlRoot: string, set: Set<ObjectId>): Promise<void> {
  const path = join(jvlRoot, EXEC_SIDECAR);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify([...set].sort(), null, 2) + "\n");
}

export async function importFromGit(
  gitRepoPath: string,
  jvlRepoPath: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const repo: Repository = await (await import("@javelin/vcs")).openRepository(jvlRepoPath);
  const warnings: string[] = [];

  const refLines = await git(
    ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"],
    gitRepoPath,
  );
  let refNames = refLines
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(41))
    .sort();
  if (opts.refs) refNames = refNames.filter((r) => opts.refs!.includes(r));

  const commitShas = new Set<string>();
  const tagTargets = new Map<string, string>();
  for (const ref of refNames) {
    const type = (await git(["cat-file", "-t", ref], gitRepoPath)).trim();
    if (type === "tag") {
      const parsed = parseTagObject(await git(["cat-file", "tag", ref], gitRepoPath));
      tagTargets.set(ref, parsed.object);
      const targetType = (await git(["cat-file", "-t", parsed.object], gitRepoPath)).trim();
      if (targetType === "commit") commitShas.add(parsed.object);
    } else if (type === "commit") {
      commitShas.add((await git(["rev-parse", ref], gitRepoPath)).trim());
    } else {
      warnings.push(`skipping ${ref}: unsupported target type ${type}`);
    }
  }

  const order: string[] = [];
  if (commitShas.size > 0) {
    const out = await git(
      ["rev-list", "--topo-order", "--reverse", ...commitShas],
      gitRepoPath,
    );
    order.push(...out.split("\n").filter(Boolean));
  }

  const shaToJvl = new Map<string, ObjectId>();
  const execSet = await loadExecSet(jvlRepoPath);
  let blobCount = 0;

  for (const sha of order) {
    const raw: GitCommitParsed = parseCommitObject(await git(["cat-file", "commit", sha], gitRepoPath));
    const lsRaw = await gitBinary(["ls-tree", "-r", "-z", raw.tree], gitRepoPath);
    const files: { path: string; id: ObjectId }[] = [];
    for (const file of parseLsTree(lsRaw)) {
      if (file.mode === "120000") {
        warnings.push(`skipping symlink ${file.path} in commit ${sha}`);
        continue;
      }
      const blob: BlobObject = {
        kind: "blob",
        data: await gitBinary(["cat-file", "blob", file.hash], gitRepoPath),
      };
      const { id } = await repo.objects.write(blob);
      blobCount++;
      if (file.mode === "100755") execSet.add(id);
      files.push({ path: file.path, id });
    }

    type Dir = Map<string, Dir | ObjectId>;
    const root: Dir = new Map();
    for (const { path, id } of files) {
      const parts = path.split("/");
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let next = dir.get(part);
        if (!(next instanceof Map)) {
          next = new Map();
          dir.set(part, next);
        }
        dir = next;
      }
      dir.set(parts[parts.length - 1]!, id);
    }
    const writeDir = async (dir: Dir): Promise<ObjectId> => {
      const entries = [];
      for (const [name, value] of dir) {
        if (value instanceof Map) {
          entries.push({ name, kind: "tree" as const, id: await writeDir(value) });
        } else {
          entries.push({ name, kind: "blob" as const, id: value });
        }
      }
      const tree = makeTree(entries);
      return (await repo.objects.write(tree)).id;
    };
    const treeId = await writeDir(root);

    const commit = {
      kind: "commit" as const,
      tree: treeId,
      parents: raw.parents.map((p) => {
        const mapped = shaToJvl.get(p);
        if (!mapped) throw new Error(`parent ${p} of ${sha} not imported yet`);
        return mapped;
      }),
      author: { name: raw.author.name, email: raw.author.email, time: raw.author.time },
      committer: { name: raw.committer.name, email: raw.committer.email, time: raw.committer.time },
      message: raw.message,
    };
    const { id } = await repo.objects.write(commit);
    shaToJvl.set(sha, id);
  }

  await saveExecSet(jvlRepoPath, execSet);

  const refs: Record<RefName, ObjectId> = {};
  for (const ref of refNames) {
    const target = tagTargets.get(ref);
    let jvlId: ObjectId;
    if (target) {
      const parsed = parseTagObject(await git(["cat-file", "tag", ref], gitRepoPath));
      const innerTarget = shaToJvl.get(parsed.object);
      if (!innerTarget) {
        warnings.push(`skipping tag ${ref}: target not importable`);
        continue;
      }
      const tag = {
        kind: "tag" as const,
        target: innerTarget,
        name: parsed.name,
        tagger: { name: parsed.tagger.name, email: parsed.tagger.email, time: parsed.tagger.time },
        message: parsed.message,
      };
      jvlId = (await repo.objects.write(tag)).id;
    } else {
      const sha = (await git(["rev-parse", ref], gitRepoPath)).trim();
      const mapped = shaToJvl.get(sha);
      if (!mapped) {
        warnings.push(`skipping ${ref}: commit not in import set`);
        continue;
      }
      jvlId = mapped;
    }
    const current = await repo.refs.get(ref as RefName);
    const result = await repo.refs.set(ref as RefName, jvlId, current);
    if (!result.ok) {
      warnings.push(`ref update rejected for ${ref}: ${result.detail}`);
      continue;
    }
    refs[ref] = jvlId;
  }

  return { commits: shaToJvl.size, blobs: blobCount, refs, warnings };
}
