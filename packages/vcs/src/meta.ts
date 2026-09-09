import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
}

/**
 * The only mutable state in a repository: world head, layer refs, contribution status.
 * Every write is an exact-string compare-and-swap under a cross-process O_EXCL lockfile
 * (docs/adr/0006). A lock left by a crashed process is stolen once its mtime ages past
 * STALE_LOCK_MS.
 */
export class MetaStore {
  private readonly lockTimeoutMs: number;

  constructor(
    readonly dir: string,
    options: MetaStoreOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  }

  private filePath(key: string): string {
    if (!KEY_RE.test(key) || key.includes("..")) throw new Error(`invalid meta key: ${key}`);
    return join(this.dir, ...key.split("/"));
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
        if (name.endsWith(".lock") || name.startsWith(".tmp-")) continue;
        const parts = [...rel, name];
        if ((await stat(join(this.dir, ...parts))).isDirectory()) await walk(parts);
        else keys.push(parts.join("/"));
      }
    };
    await walk([]);
    return keys.filter((key) => key.startsWith(prefix));
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.filePath(key) + ".lock";
    await mkdir(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        await writeFile(lockPath, `pid:${process.pid}`, { flag: "wx" });
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
        let age = 0;
        try {
          age = Date.now() - (await stat(lockPath)).mtimeMs;
        } catch {
          continue;
        }
        if (age > STALE_LOCK_MS) await rm(lockPath).catch(() => {});
        if (Date.now() > deadline) throw new Error(`meta lock timeout: ${key}`);
        await Bun.sleep(RETRY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath).catch(() => {});
    }
  }
  private async atomicWrite(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.tmp-${crypto.randomUUID()}`);
    await writeFile(tmp, contents);
    await rename(tmp, path);
  }
}
