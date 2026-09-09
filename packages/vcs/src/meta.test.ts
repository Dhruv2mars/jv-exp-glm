import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaStore } from "./meta";

let dir: string;
let metaDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jvl-meta-"));
  metaDir = join(dir, "meta");
  await mkdir(metaDir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MetaStore", () => {
  test("get on missing key is null", async () => {
    const store = new MetaStore(metaDir);
    expect(await store.get("world")).toBeNull();
  });

  test("create fails when key exists, succeeds when absent", async () => {
    const store = new MetaStore(metaDir);
    expect(await store.create("world", "a")).toBe(true);
    expect(await store.create("world", "b")).toBe(false);
    expect(await store.get("world")).toBe("a");
  });

  test("compareAndSwap wins on exact match, fails otherwise", async () => {
    const store = new MetaStore(metaDir);
    await store.create("world", "a");
    const miss = await store.compareAndSwap("world", "b", "c");
    expect(miss.ok).toBe(false);
    expect(miss.current).toBe("a");
    const hit = await store.compareAndSwap("world", "a", "c");
    expect(hit.ok).toBe(true);
    expect(await store.get("world")).toBe("c");
    const fromNull = await store.compareAndSwap("missing", null, "x");
    expect(fromNull.ok).toBe(true);
  });

  test("exact string comparison, including empty values", async () => {
    const store = new MetaStore(metaDir);
    await store.create("current", "world");
    expect((await store.compareAndSwap("current", "World", "x")).ok).toBe(false);
    expect((await store.compareAndSwap("current", "world", "x")).ok).toBe(true);
  });

  test("delete removes the key and reports existence", async () => {
    const store = new MetaStore(metaDir);
    await store.create("layer/one", "v");
    expect(await store.delete("layer/one")).toBe(true);
    expect(await store.delete("layer/one")).toBe(false);
    expect(await store.get("layer/one")).toBeNull();
  });

  test("list returns keys under a prefix, skipping lock and temp files", async () => {
    const store = new MetaStore(metaDir);
    await store.create("layer/alpha", "1");
    await store.create("layer/beta", "2");
    await store.create("world", "3");
    await writeFile(join(metaDir, "layer", "gamma.lock"), "junk");
    expect(await store.list("layer/")).toEqual(["layer/alpha", "layer/beta"]);
    expect(await store.list()).toEqual(["layer/alpha", "layer/beta", "world"]);
  });

  test("rejects invalid keys", async () => {
    const store = new MetaStore(metaDir);
    await expect(store.get("../escape")).rejects.toThrow();
    await expect(store.create("a/b/../../c", "x")).rejects.toThrow();
  });

  test("a stale lock is stolen after the mtime threshold", async () => {
    const store = new MetaStore(metaDir);
    const lockPath = join(metaDir, "k.lock");
    await writeFile(lockPath, "pid:crashed");
    const backdated = new Date(Date.now() - 11_000);
    await utimes(lockPath, backdated, backdated);
    expect(await store.create("k", "v")).toBe(true);
    expect(await store.get("k")).toBe("v");
  });

  test("a fresh lock blocks until the timeout", async () => {
    const store = new MetaStore(metaDir, { lockTimeoutMs: 300 });
    await writeFile(join(metaDir, "k.lock"), "pid:live");
    await expect(store.create("k", "v")).rejects.toThrow("meta lock timeout: k");
    expect(await store.get("k")).toBeNull();
  });

  test("two real bun processes race one CAS key; exactly one winner per round", async () => {
    const store = new MetaStore(metaDir);
    const workerPath = join(dir, "cas-worker.ts");
    const src = `
import { MetaStore } from ${JSON.stringify(join(import.meta.dir, "meta.ts"))};
const store = new MetaStore(process.argv[2]);
let wins = 0;
let expected = await store.get("race");
let round = 1;
while (round <= 20) {
  const res = await store.compareAndSwap("race", expected, round + ":" + process.pid);
  if (res.ok) { wins++; expected = res.current; round++; continue; }
  const current = await store.get("race");
  if (current === null) break;
  expected = current;
  const done = Number.parseInt(current, 10);
  if (done >= round) round = done + 1;
}
console.log(wins);
`;
    await writeFile(workerPath, src);
    await store.create("race", "0:x");
    const procs = [1, 2].map(() =>
      Bun.spawn({ cmd: [process.execPath, workerPath, metaDir], stdout: "pipe", stderr: "pipe" }),
    );
    const outs = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text() })));
    expect(outs.map((o) => o.code)).toEqual([0, 0]);
    const wins = outs.map((o) => Number.parseInt(o.out.trim(), 10));
    expect(wins[0]! + wins[1]!).toBe(20);
    expect(await store.get("race")).toMatch(/^20:\d+$/);
  }, 30_000);
});
