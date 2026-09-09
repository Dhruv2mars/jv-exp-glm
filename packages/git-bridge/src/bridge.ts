import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectId } from "@javelin/protocol";

export type MirrorMode = "adoption" | "native";
export type MirrorAuthority = "github" | "javelin";

/** Persistent git-commit-sha -> javelin-state-id identity mapping (plus tag metadata). */
export interface BridgeMap {
  commits: Record<string, ObjectId>;
  tags: Record<string, ObjectId>;
}

/** ADR 0009 mirror-mode marker. Records which side is authoritative; never drives behavior. */
export interface MirrorMarker {
  mode: MirrorMode;
  authority: MirrorAuthority;
  at: string;
}

const MAP_PATH = join(".javelin", "bridge-map.json");
const MARKER_PATH = join(".javelin", "bridge.json");

export async function loadBridgeMap(jvlRoot: string): Promise<BridgeMap> {
  try {
    const parsed = JSON.parse(await readFile(join(jvlRoot, MAP_PATH), "utf8")) as Partial<BridgeMap>;
    return { commits: parsed.commits ?? {}, tags: parsed.tags ?? {} };
  } catch {
    return { commits: {}, tags: {} };
  }
}

export async function saveBridgeMap(jvlRoot: string, map: BridgeMap): Promise<void> {
  await writeJson(join(jvlRoot, MAP_PATH), {
    commits: sortedEntries(map.commits),
    tags: sortedEntries(map.tags),
  });
}

export async function writeMirrorMarker(
  jvlRoot: string,
  mode: MirrorMode,
  authority: MirrorAuthority,
): Promise<void> {
  const marker: MirrorMarker = { mode, authority, at: new Date().toISOString() };
  await writeJson(join(jvlRoot, MARKER_PATH), marker);
}

function sortedEntries<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
