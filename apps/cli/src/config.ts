import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RemoteConfig {
  url: string;
  token?: string;
}

export interface JavelinConfig {
  remotes: Record<string, RemoteConfig>;
}

const EMPTY: JavelinConfig = { remotes: {} };

export function configPath(root: string): string {
  return join(root, ".javelin", "config.json");
}

export async function loadConfig(root: string): Promise<JavelinConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(root), "utf8")) as Partial<JavelinConfig>;
    return { remotes: raw.remotes ?? {} };
  } catch {
    return { ...EMPTY, remotes: {} };
  }
}

export async function saveConfig(root: string, config: JavelinConfig): Promise<void> {
  const path = configPath(root);
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${crypto.randomUUID()}`);
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n");
  await rename(tmp, path);
}

/** Repo name a remote URL points at, e.g. http://host:8080/foo -> foo. */
export function repoNameFromUrl(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, "");
  const name = path.split("/").pop() ?? "";
  if (!name) throw new Error(`cannot derive repository name from url: ${url}`);
  return name;
}

/** Base URL a remote URL points at, e.g. http://host:8080/foo -> http://host:8080. */
export function baseUrlFromUrl(url: string): string {
  const u = new URL(url);
  return u.origin;
}
