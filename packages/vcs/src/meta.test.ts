import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaStore } from "./meta";

let dir: string;
let metaDir: string;
const lockPath = () => join(metaDir, "k.lock");

function locker(store: MetaStore): { withLock: (key: string, fn: () => Promise<string>) => Promise<string> } {
  return store as unknown as { withLock: (key: string, fn: () => Promise<string>) => Promise<string> };
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (;;) {
    if (await check()) return;
    await Bun.sleep(5);
  }
}

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

  test("two real bun processes race one CAS key; exactly one winner per round", async () => {    const store = new MetaStore(metaDir);
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

  test("two racers CASing from the same expected: exactly one ok", async () => {
    const s1 = new MetaStore(metaDir);
    const s2 = new MetaStore(metaDir);
    const [r1, r2] = await Promise.all([
      s1.compareAndSwap("race", null, "one"),
      s2.compareAndSwap("race", null, "two"),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const winner = r1.ok ? r1 : r2;
    expect(await s1.get("race")).toBe(winner.current);
  });

  test("the original holder's late release does not delete the new holder's lock", async () => {
    const storeA = new MetaStore(metaDir);
    const storeB = new MetaStore(metaDir);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const holdA = locker(storeA).withLock("k", async () => {
      await gateA;
      return "A";
    });
    await until(() => readFile(lockPath(), "utf8").then(() => true).catch(() => false));
    const backdated = new Date(Date.now() - 11_000);
    await utimes(lockPath(), backdated, backdated);

    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const holdB = locker(storeB).withLock("k", async () => {
      await gateB;
      return "B";
    });
    await until(async () => {
      const stats = await stat(lockPath()).catch(() => null);
      return stats !== null && Date.now() - stats.mtimeMs < 2_000;
    });

    releaseA();
    expect(await holdA).toBe("A");
    const held = await readFile(lockPath(), "utf8");
    expect(held).not.toContain(String(process.pid));

    releaseB();
    expect(await holdB).toBe("B");
    await until(() => readFile(lockPath(), "utf8").then(() => false).catch(() => true));
  });

  test("a live slow holder is never stolen from; bodies never overlap", async () => {
    let inside = 0;
    let maxInside = 0;
    const track = (fn: () => Promise<string>): Promise<string> => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      return fn().finally(() => {
        inside--;
      });
    };
    const storeA = new MetaStore(metaDir, { staleLockMs: 120 });
    const storeB = new MetaStore(metaDir, { staleLockMs: 120, lockTimeoutMs: 5_000 });
    const holdA = locker(storeA).withLock("k", () =>
      track(async () => {
        await Bun.sleep(400);
        return "A";
      }),
    );
    const holdB = locker(storeB).withLock("k", () => track(async () => "B"));
    expect(await Promise.all([holdA, holdB])).toEqual(["A", "B"]);
    expect(maxInside).toBe(1);
  }, 15_000);
});
