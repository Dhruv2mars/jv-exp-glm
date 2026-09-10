import { openSync, writeSync, closeSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync, fsyncSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cborDecode, cborEncode, type CborValue } from './cbor.ts'

// The mutable reference plane: tiny versioned pointer files, one per
// mutable root (world head, each layer head). Immutable objects never need
// a lock; only these files do, and each ref locks independently, so Layer A
// autosaving never blocks Layer B. Writes go through temp + rename, so a
// reader never observes a torn ref, and a crash leaves either the old or
// the new file, never a mixture.

export interface RefEntry<T = CborValue> {
  gen: number
  data: T
}

export class CasConflict extends Error {
  constructor(readonly ref: string) {
    super(`compare-and-swap failed on ref ${ref}`)
  }
}

export class LockTimeout extends Error {
  constructor(readonly path: string) {
    super(`timed out acquiring lock ${path}`)
  }
}

interface LockBody {
  pid: number
  at: number
}

const STALE_MS = 30_000
// A lock whose body is unreadable was most likely torn by a crash between
// create and body write; two seconds is enough to rule out that window.
const UNREADABLE_GRACE_MS = 2_000

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class Refs {
  constructor(readonly root: string) {}

  static open(root: string): Refs {
    mkdirSync(join(root, 'refs'), { recursive: true })
    mkdirSync(join(root, 'locks'), { recursive: true })
    return new Refs(root)
  }

  private refPath(name: string): string {
    return join(this.root, 'refs', name)
  }

  private lockPath(name: string): string {
    return join(this.root, 'locks', `${name.replace(/\//g, '__')}.lock`)
  }

  read<T = CborValue>(name: string): RefEntry<T> | null {
    const path = this.refPath(name)
    if (!existsSync(path)) return null
    const decoded = cborDecode(new Uint8Array(readFileSync(path))) as { v: number; gen: number; data: T }
    return { gen: decoded.gen, data: decoded.data }
  }

  // The lock is advisory and stolen when its owner dies or stalls, so a
  // crash can never strand the repository.
  private withLock<T>(name: string, fn: () => T): T {
    const path = this.lockPath(name)
    // The deadline must exceed STALE_MS so a stalled live holder is
    // reachable by the staleness steal.
    const deadline = Date.now() + STALE_MS + 5_000
    for (;;) {
      try {
        const fd = openSync(path, 'wx')
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockBody))
        closeSync(fd)
        break
      } catch {
        let steal = false
        try {
          const body = JSON.parse(readFileSync(path, 'utf8')) as LockBody
          const age = Date.now() - statSync(path).mtimeMs
          steal = !pidAlive(body.pid) || age > STALE_MS
      } catch {
        // An unreadable lock (crash between create and body write) is only
        // stolen once it is old; a live writer may still be initialising it.
        try {
          steal = Date.now() - statSync(path).mtimeMs > UNREADABLE_GRACE_MS
        } catch {
          steal = false
        }
      }
        if (steal) {
          try {
            unlinkSync(path)
          } catch {
            // another process stole it first
          }
        }
        if (Date.now() > deadline) throw new LockTimeout(path)
        Bun.sleepSync(25)
      }
    }
    try {
      return fn()
    } finally {
      try {
        unlinkSync(path)
      } catch {
        // best-effort release; stale detection covers the gap
      }
    }
  }

  private writeEntry<T>(name: string, gen: number, data: T, fsyncDir: boolean): void {
    const path = this.refPath(name)
    const bytes = cborEncode({ v: 1, gen, data: data as CborValue })
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
    if (fsyncDir) {
      const dir = openSync(dirname(path), 'r')
      try {
        fsyncSync(dir)
      } finally {
        closeSync(dir)
      }
    }
  }

  init<T>(name: string, data: T): RefEntry<T> {
    return this.withLock(name, () => {
      const existing = this.read<T>(name)
      if (existing) return existing
      this.writeEntry(name, 1, data, false)
      return { gen: 1, data }
    })
  }

  // Compare-and-swap: the write lands only if the ref still has expectedGen.
  casWrite<T>(name: string, expectedGen: number, data: T, opts?: { fsyncDir?: boolean }): RefEntry<T> {
    return this.withLock(name, () => {
      const current = this.read<T>(name)
      const currentGen = current?.gen ?? 0
      if (currentGen !== expectedGen) throw new CasConflict(name)
      this.writeEntry(name, expectedGen + 1, data, opts?.fsyncDir === true)
      return { gen: expectedGen + 1, data }
    })
  }

  // Read-modify-write with bounded retry for concurrent mutators.
  update<T>(name: string, mutate: (data: T | null) => T, opts?: { fsyncDir?: boolean }): RefEntry<T> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const current = this.read<T>(name)
      const next = mutate(current?.data ?? null)
      try {
        return this.casWrite(name, current?.gen ?? 0, next, opts)
      } catch (e) {
        if (e instanceof CasConflict) continue
        throw e
      }
    }
    throw new CasConflict(name)
  }
}
