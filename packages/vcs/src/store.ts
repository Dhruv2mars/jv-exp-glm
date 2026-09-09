import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectId } from "@javelin/protocol";
import { isObjectId } from "@javelin/protocol";
import { decodeObject, encodeObject, hashEncoding, type StoredObject } from "./objects";

export interface WriteResult {
  id: ObjectId;
  written: boolean;
}

export class ObjectStore {
  constructor(readonly dir: string) {}

  shardPath(id: ObjectId): string {
    return join(this.dir, id.slice(0, 2), id.slice(2));
  }

  /** File mtime in ms, or null when absent. */
  async mtime(id: ObjectId): Promise<number | null> {
    try {
      return (await stat(this.shardPath(id))).mtimeMs;
    } catch {
      return null;
    }
  }

  async remove(id: ObjectId): Promise<void> {
    await rm(this.shardPath(id), { force: true });
  }

  async write(obj: StoredObject): Promise<WriteResult> {
    const encoding = encodeObject(obj);
    const id = await hashEncoding(encoding);
    const path = this.shardPath(id);
    let exists = false;
    try {
      exists = (await stat(path)).isFile();
    } catch {
      exists = false;
    }
    if (exists) return { id, written: false };
    const shard = join(this.dir, id.slice(0, 2));
    await mkdir(shard, { recursive: true });
    const tmp = join(shard, `.tmp-${crypto.randomUUID()}`);
    await writeFile(tmp, encoding);
    await rename(tmp, path);
    return { id, written: true };
  }

  async read(id: ObjectId): Promise<StoredObject | null> {
    let encoding: Buffer;
    try {
      encoding = await readFile(this.shardPath(id));
    } catch {
      return null;
    }
    try {
      return decodeObject(new Uint8Array(encoding));
    } catch {
      return null;
    }
  }

  /** Like read, but distinguishes a present-but-corrupt file from a missing one. */
  async readRaw(id: ObjectId): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.shardPath(id)));
    } catch {
      return null;
    }
  }

  async has(id: ObjectId): Promise<boolean> {
    try {
      return (await stat(this.shardPath(id))).isFile();
    } catch {
      return false;
    }
  }

  async list(): Promise<ObjectId[]> {
    const ids: ObjectId[] = [];
    let shards: string[];
    try {
      shards = await readdir(this.dir);
    } catch {
      return ids;
    }
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      for (const rest of await readdir(join(this.dir, shard))) {
        if (rest.startsWith(".")) continue;
        const hex = shard + rest;
        if (isObjectId(hex)) ids.push(hex);
      }
    }
    return ids.sort();
  }

  /** Removes leftover temp files from interrupted writes. */
  async cleanTemp(): Promise<number> {
    let removed = 0;
    let shards: string[];
    try {
      shards = await readdir(this.dir);
    } catch {
      return removed;
    }
    for (const shard of shards) {
      const shardDir = join(this.dir, shard);
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      for (const name of await readdir(shardDir)) {
        if (!name.startsWith(".tmp-")) continue;
        await rm(join(shardDir, name));
        removed++;
      }
    }
    return removed;
  }
}
