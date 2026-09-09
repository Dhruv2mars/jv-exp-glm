import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, decodeObject, encodeObject, hashEncoding } from "./objects";
import { ObjectStore } from "./store";
import { objectId } from "@javelin/protocol";

const treeId = objectId("a".repeat(64));
const blobId = objectId("b".repeat(64));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jvl-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("canonical encoding", () => {
  test("key order does not affect id", async () => {
    const a = { kind: "state" as const, tree: treeId, parents: [], message: "hi", author: { name: "n", email: "e", time: "t" } };
    const b = { message: "hi", author: { time: "t", email: "e", name: "n" }, parents: [], tree: treeId, kind: "state" as const };
    expect(await hashEncoding(encodeObject(a))).toBe(await hashEncoding(encodeObject(b)));
  });

  test("canonicalJson sorts nested keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
  });

  test("blob round-trips raw bytes", () => {
    const data = new Uint8Array([0, 1, 2, 255]);
    const decoded = decodeObject(encodeObject({ kind: "blob", data }));
    expect(decoded).toEqual({ kind: "blob", data });
  });

  test("tree entry carries mode", () => {
    const tree = { kind: "tree" as const, entries: [{ name: "run.sh", mode: "exec" as const, kind: "blob" as const, id: blobId }] };
    const round = decodeObject(encodeObject(tree));
    expect(round).toEqual(tree);
  });
});

describe("ObjectStore", () => {
  test("write/read round-trip and sharding", async () => {
    const store = new ObjectStore(join(dir, "objects"));
    const blob = { kind: "blob" as const, data: new TextEncoder().encode("hello") };
    const { id, written } = await store.write(blob);
    expect(written).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const shards = await readdir(join(dir, "objects"));
    expect(shards).toEqual([id.slice(0, 2)]);
    const read = await store.read(id);
    expect(read).toEqual(blob);
  });

  test("idempotent write", async () => {
    const store = new ObjectStore(join(dir, "objects"));
    const blob = { kind: "blob" as const, data: new Uint8Array([9, 9]) };
    const first = await store.write(blob);
    const second = await store.write(blob);
    expect(second.written).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
  });

  test("interrupted temp files are ignored and cleaned, retry converges", async () => {
    const shardDir = join(dir, "objects", "ab");
    await mkdir(shardDir, { recursive: true });
    await writeFile(join(shardDir, ".tmp-interrupted"), "garbage");
    const store = new ObjectStore(join(dir, "objects"));
    expect(await store.list()).toEqual([]);
    const blob = { kind: "blob" as const, data: new Uint8Array([1]) };
    const { id } = await store.write(blob);
    expect(await store.has(id)).toBe(true);
    expect(await store.cleanTemp()).toBe(1);
    expect(await store.list()).toEqual([id]);
  });

  test("list over empty store", async () => {
    expect(await new ObjectStore(join(dir, "missing")).list()).toEqual([]);
  });
});
