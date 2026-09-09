import { mkdirSync, openSync, writeSync, closeSync, renameSync, readFileSync, existsSync, fsyncSync, unlinkSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cborDecode, cborEncode, type CborValue } from './cbor.ts'
import { typedHash, type Oid } from './oids.ts'

// Loose content-addressed object store. This is the correctness oracle
// backend: one file per object, written atomically via temp + rename, so
// writing an existing id is a no-op and readers never see torn objects.
// Segment packing and compression are later optimizations behind this
// same interface.

export class ObjectStore {
  constructor(readonly dir: string) {}

  static open(dir: string): ObjectStore {
    mkdirSync(dir, { recursive: true })
    return new ObjectStore(dir)
  }

  private path(id: Oid): string {
    const hex = id.hex
    return join(this.dir, hex.slice(0, 2), hex.slice(2))
  }

  has(id: Oid): boolean {
    return existsSync(this.path(id))
  }

  put(domain: string, payload: Uint8Array): Oid {
    const id = typedHash(domain, payload)
    const target = this.path(id)
    if (existsSync(target)) return id
    const tmp = join(this.dir, `.tmp-${id.hex}-${process.pid}-${Date.now()}`)
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, payload)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    mkdirSync(dirname(target), { recursive: true })
    renameSync(tmp, target)
    return id
  }

  get(id: Oid): Uint8Array {
    const data = readFileSync(this.path(id))
    return new Uint8Array(data)
  }

  getIfPresent(id: Oid): Uint8Array | null {
    try {
      return this.get(id)
    } catch {
      return null
    }
  }

  // Cryptographic identity is authoritative. A payload that does not hash
  // to its id is corruption; callers refuse to depend on it.
  verify(domain: string, id: Oid): boolean {
    const payload = this.getIfPresent(id)
    if (!payload) return false
    return typedHash(domain, payload, id.algo).equals(id)
  }

  putRecord(domain: string, record: CborValue): { id: Oid; bytes: Uint8Array } {
    const bytes = cborEncode(record)
    return { id: this.put(domain, bytes), bytes }
  }

  getRecord(domain: string, id: Oid): { record: CborValue; bytes: Uint8Array } {
    const bytes = this.get(id)
    if (!typedHash(domain, bytes, id.algo).equals(id)) {
      throw new Error(`object ${id.ref} does not match its ${domain} identity`)
    }
    return { record: cborDecode(bytes), bytes }
  }

  delete(id: Oid): void {
    const p = this.path(id)
    if (existsSync(p)) unlinkSync(p)
  }
}

export function objectCount(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const shard of readdirSync(dir)) {
    if (shard.startsWith('.tmp')) continue
    n += readdirSync(join(dir, shard)).length
  }
  return n
}
