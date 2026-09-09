import { spawnSync } from "node:child_process";
import { objectId, type ObjectId } from "@javelin/protocol";
import type { Author, ContributionMeta, FileMap, MergeConflict, Repository } from "@javelin/vcs";
import type { Contribution } from "@javelin/sdk";

export function worldValue(id: ObjectId | null): string {
  return JSON.stringify({ value: id });
}

/** Flatten a state's tree into path -> {id, mode} using only the public Repository surface. */
export async function flattenTree(repo: Repository, stateId: ObjectId): Promise<FileMap> {
  const files: FileMap = {};
  const walk = async (treeId: ObjectId, dir: string): Promise<void> => {
    const tree = await repo.loadTree(treeId);
    for (const entry of tree.entries) {
      const full = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === "tree") await walk(entry.id, full);
      else files[full] = { id: entry.id, mode: entry.mode };
    }
  };
  await walk((await repo.loadState(stateId)).tree, "");
  return files;
}

export interface FileDiff {
  path: string;
  status: "added" | "deleted" | "modified";
}

export function diffFileMaps(a: FileMap, b: FileMap): FileDiff[] {
  const out: FileDiff[] = [];
  for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[path];
    const y = b[path];
    if (x?.id === y?.id && x?.mode === y?.mode) continue;
    if (!y) out.push({ path, status: "deleted" });
    else if (!x) out.push({ path, status: "added" });
    else out.push({ path, status: "modified" });
  }
  return out;
}

export function formatDiff(entries: FileDiff[]): string {
  return entries.map((e) => `${e.status.padEnd(9)} ${e.path}`).join("\n");
}

export function formatConflicts(conflicts: MergeConflict[]): string {
  return conflicts.map((c) => `  conflict: ${c.path} (${c.kind})`).join("\n");
}

function gitConfig(field: "user.name" | "user.email"): string | null {
  const res = spawnSync("git", ["config", "--get", field], { encoding: "utf8" });
  const value = res.status === 0 ? res.stdout.trim() : "";
  return value !== "" ? value : null;
}

/** Env overrides git config, matching git's own precedence; javelin defaults last. */
export function resolveAuthor(): Author {
  return {
    name: process.env.GIT_AUTHOR_NAME ?? gitConfig("user.name") ?? "javelin",
    email: process.env.GIT_AUTHOR_EMAIL ?? gitConfig("user.email") ?? "javelin@local",
  };
}

export interface LocalContribution {
  id: ObjectId;
  contribution: Contribution;
  meta: ContributionMeta;
}

export async function listLocalContributions(repo: Repository): Promise<LocalContribution[]> {
  const out: LocalContribution[] = [];
  for (const key of await repo.meta.list("contrib/")) {
    const id = objectId(key.slice("contrib/".length));
    const found = await repo.contribution(id);
    if (found) out.push({ id, contribution: found.contribution, meta: found.meta });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
