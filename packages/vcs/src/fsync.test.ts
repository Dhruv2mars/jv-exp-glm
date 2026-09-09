import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fsReal from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fsyncCalls: number[] = [];

mock.module("node:fs/promises", () => {
  const mocked = {
    ...fsReal,
    fsync: async (handle: { fd: number }) => {
      fsyncCalls.push(handle.fd);
      return fsReal.fsync(handle as never);
    },
  };
  return { ...mocked, default: mocked };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jvl-fsync-"));
  fsyncCalls.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("durability", () => {
  test("meta atomicWrite fsyncs the temp file and the parent directory", async () => {
    const { MetaStore } = await import("./meta");
    const store = new MetaStore(join(dir, "meta"));
    await store.create("world", "v");
    expect(fsyncCalls.length).toBeGreaterThanOrEqual(2);
    expect(await store.get("world")).toBe("v");
  });

  test("object writes fsync the temp file and the shard directory", async () => {
    const { ObjectStore } = await import("./store");
    const store = new ObjectStore(join(dir, "objects"));
    const { id } = await store.write({ kind: "blob", data: new TextEncoder().encode("hello") });
    expect(fsyncCalls.length).toBeGreaterThanOrEqual(2);
    expect(await store.has(id)).toBe(true);
  });
});
