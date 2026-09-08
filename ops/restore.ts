#!/usr/bin/env bun
import { readFile, readdir, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { isRepoDir } from "./backup";

/**
 * Restore recreates a javelind root from an archive produced by ops/backup.ts.
 * The target root must not exist or must be empty; restore refuses to clobber.
 */

interface Manifest {
  createdAt: string;
  repos: string[];
}

export async function restoreRoot(archivePath: string, root: string): Promise<string[]> {
  const raw = await readFile(join(archivePath, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as Manifest;
  let existing: string[] = [];
  try {
    existing = await readdir(root);
  } catch {
    // missing root is fine
  }
  if (existing.length > 0) {
    throw new Error(`refusing to restore into non-empty root ${root}`);
  }
  for (const name of manifest.repos) {
    if (!(await isRepoDir(join(archivePath, name)))) {
      throw new Error(`archive missing repository directory: ${name}`);
    }
    await mkdir(root, { recursive: true });
    await cp(join(archivePath, name), join(root, name), { recursive: true });
  }
  return manifest.repos;
}

async function main(): Promise<void> {
  function argValue(name: string): string | undefined {
    const args = process.argv.slice(2);
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  }
  const archive = argValue("archive");
  const root = argValue("root");
  if (!archive || !root) {
    console.error("usage: bun run ops/restore.ts --archive <archive-dir> --root <new-javelind-root>");
    process.exit(1);
  }
  const repos = await restoreRoot(archive, root);
  console.log(`restored ${repos.length} repos into ${root}: ${repos.join(", ")}`);
}

if (import.meta.main) await main();
