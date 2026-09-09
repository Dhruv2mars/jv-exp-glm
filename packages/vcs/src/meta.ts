import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;
const RETRY_MS = 15;

export interface CasResult {
  ok: boolean;
  /** Exact current value after the attempt. */
  current: string | null;
}

export interface MetaStoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

/**
 * The only mutable state in a repository: world head, layer refs, contribution status.
 * Every write is an exact-string compare-and-swap under a cross-process O_EXCL lockfile
 * (docs/adr/0006). The lock carries a random owner token: release deletes the file only
 * when the token still matches, so a stolen lock is never unlinked by its previous
 * holder. A live holder heartbeats the lock mtime; a lock left by a crashed process is
 * stolen once its mtime ages past the stale threshold.
 */
function lockValue(token: string): string {
  return JSON.stringify({ token, pid: process.pid });
}

export class MetaStore {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(
    readonly dir: string,
    options: MetaStoreOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
  }

  private filePath(key: string): string {
    if (!KEY_RE.test(key) || key.includes("..")) throw new Error(`invalid meta key: ${key}`);
    return join(this.dir, ...key.split("/"));
  }

  private lockPath(key: string): string {
    return join(this.dir, ".locks", `${encodeURIComponent(key)}.lock`);
  }

  async get(key: string): Promise<string | null> {
    const path = this.filePath(key);
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  async compareAndSwap(key: string, expected: string | null, next: string): Promise<CasResult> {
    return this.withLock(key, async () => {
      const current = await this.get(key);
      if (current !== expected) return { ok: false, current };
      await this.atomicWrite(this.filePath(key), next);
      return { ok: true, current: next };
    });
  }

  async create(key: string, value: string): Promise<boolean> {
    return (await this.compareAndSwap(key, null, value)).ok;
  }

  async delete(key: string): Promise<boolean> {
    return this.withLock(key, async () => {
      try {
        await rm(this.filePath(key));
        return true;
      } catch {
        return false;
      }
    });
  }

  async list(prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (rel: string[]): Promise<void> => {
      const dir = join(this.dir, ...rel);
      let entries: string[];
      try {
        entries = (await readdir(dir, { withFileTypes: true })).map((e) => e.name);
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        if (name === ".locks" || name.startsWith(".tmp-")) continue;
        const parts = [...rel, name];
        if ((await stat(join(this.dir, ...parts))).isDirectory()) await walk(parts);
        else keys.push(parts.join("/"));
      }
    };
    await walk([]);
    return keys.filter((key) => key.startsWith(prefix));
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(key);
    await mkdir(dirname(lockPath), { recursive: true });
    const token = crypto.randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        await writeFile(lockPath, lockValue(token), { flag: "wx" });
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
        let age = 0;
        try {
          age = Date.now() - (await stat(lockPath)).mtimeMs;
        } catch {
          continue;
        }
        if (age > this.staleLockMs) {
          const stolen = `${lockPath}.${token}.stolen`;
          try {
            await rename(lockPath, stolen);
            await rm(stolen).catch(() => {});
          } catch {
            // another process moved it first; retry the acquire
          }
          continue;
        }
        if (Date.now() > deadline) throw new Error(`meta lock timeout: ${key}`);
        await Bun.sleep(RETRY_MS);
      }
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lockPath, now, now).catch(() => {});
    }, Math.max(this.staleLockMs / 3, 5));
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      const current = await readFile(lockPath, "utf8").catch(() => null);
      if (current === lockValue(token)) await rm(lockPath).catch(() => {});
    }
  }
  private async atomicWrite(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.tmp-${crypto.randomUUID()}`);
    await writeFile(tmp, contents);
    await rename(tmp, path);
  }
}
