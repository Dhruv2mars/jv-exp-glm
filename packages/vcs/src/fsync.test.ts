import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PatchableHandle {
  sync: () => Promise<void>;
}

let dir: string;
let syncCalls: number[];
let originalSync: (() => Promise<void>) | null = null;
let handleProto: PatchableHandle | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jvl-fsync-"));
  syncCalls = [];
  const probe = await open(join(dir, "probe"), "w");
  handleProto = Object.getPrototypeOf(probe) as PatchableHandle;
  await probe.close();
  originalSync = handleProto.sync;
  handleProto.sync = async function () {
    syncCalls.push(1);
    return originalSync!.call(this);
  };
});
afterEach(async () => {
  if (handleProto && originalSync) handleProto.sync = originalSync;
  await rm(dir, { recursive: true, force: true });
});

describe("durability", () => {
  test("meta atomicWrite fsyncs the temp file and the parent directory", async () => {
    const { MetaStore } = await import("./meta");
    const store = new MetaStore(join(dir, "meta"));
    await store.create("world", "v");
    expect(syncCalls.length).toBeGreaterThanOrEqual(2);
    expect(await store.get("world")).toBe("v");
  });

  test("object writes fsync the temp file and the shard directory", async () => {
    const { ObjectStore } = await import("./store");
    const store = new ObjectStore(join(dir, "objects"));
    const { id } = await store.write({ kind: "blob", data: new TextEncoder().encode("hello") });
    expect(syncCalls.length).toBeGreaterThanOrEqual(2);
    expect(await store.has(id)).toBe(true);
  });
});
