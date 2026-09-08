#!/usr/bin/env bun
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Backup is a plain recursive file copy (no tar) of every repository directory
 * under a javelind root into a timestamped archive directory. Plain copy keeps
 * restore a symmetric cp -r and avoids tar flag differences across platforms.
 * Stop javelind (or accept a torn copy) before backing up a live root; the
 * file layout is immutable objects plus atomically-renamed refs, so a quiescent
 * copy is always consistent.
 */

export interface BackupResult {
  archivePath: string;
  repos: string[];
}

interface Manifest {
  createdAt: string;
  repos: string[];
}

export function isRepoDir(path: string): Promise<boolean> {
  return readFile(join(path, ".javelin", "meta.json"), "utf8").then(
    () => true,
    () => false,
  );
}

/** List repository directory names under a javelind root. */
export async function listRepoDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && (await isRepoDir(join(root, e.name)))) names.push(e.name);
  }
  return names.sort();
}

export async function backupRoot(root: string, archiveDir: string): Promise<BackupResult> {
  const repos = await listRepoDirs(root);
  if (repos.length === 0) throw new Error(`no repositories found under ${root}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archiveDir, stamp);
  await mkdir(archivePath, { recursive: true });
  for (const name of repos) {
    await cp(join(root, name), join(archivePath, name), { recursive: true });
  }
  const manifest: Manifest = { createdAt: new Date().toISOString(), repos };
  await writeFile(join(archivePath, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { archivePath, repos };
}

async function main(): Promise<void> {
  function argValue(name: string): string | undefined {
    const args = process.argv.slice(2);
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  }
  const root = argValue("root");
  const archive = argValue("archive");
  if (!root || !archive) {
    console.error("usage: bun run ops/backup.ts --root <javelind-root> --archive <dir>");
    process.exit(1);
  }
  const { archivePath, repos } = await backupRoot(root, archive);
  console.log(`backed up ${repos.length} repos to ${archivePath}: ${repos.join(", ")}`);
}

if (import.meta.main) await main();
