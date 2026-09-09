import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { Refs, CasConflict } from '../src/core/refs.ts'

function tmp(name: string): Refs {
  const dir = join(import.meta.dir, '.tmp', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return Refs.open(dir)
}

describe('refs plane', () => {
  test('init, read, and cas round-trip', () => {
    const refs = tmp('refs-basic')
    const entry = refs.init('world', { head: 'v1' })
    expect(entry.gen).toBe(1)
    expect(refs.read<{ head: string }>('world')!.data.head).toBe('v1')

    const next = refs.casWrite('world', 1, { head: 'v2' })
    expect(next.gen).toBe(2)
    expect(refs.read<{ head: string }>('world')!.data.head).toBe('v2')
  })

  test('cas rejects a stale generation', () => {
    const refs = tmp('refs-cas')
    refs.init('layers/a', { root: 'r1' })
    refs.casWrite('layers/a', 1, { root: 'r2' })
    expect(() => refs.casWrite('layers/a', 1, { root: 'r3' })).toThrow(CasConflict)
  })

  test('update retries through concurrent generations', () => {
    const refs = tmp('refs-update')
    refs.init('world', { seq: 0 })
    refs.casWrite('world', 1, { seq: 1 })
    const after = refs.update<{ seq: number }>('world', (d) => ({ seq: (d?.seq ?? 0) + 10 }))
    expect(after.data.seq).toBe(11)
  })

  test("a dead holder's lock is stolen", () => {
    const refs = tmp('refs-stale')
    writeFileSync(join(refs.root, 'locks', 'world.lock'), JSON.stringify({ pid: 999_999_999, at: Date.now() }))
    const entry = refs.init('world', { head: 'v1' })
    expect(entry.gen).toBe(1)
  })

  test('separate Refs instances coordinate through the filesystem', () => {
    const refsA = tmp('refs-multi')
    const refsB = Refs.open(refsA.root)
    refsA.init('world', { seq: 0 })
    refsB.update<{ seq: number }>('world', (d) => ({ seq: (d?.seq ?? 0) + 1 }))
    refsA.update<{ seq: number }>('world', (d) => ({ seq: (d?.seq ?? 0) + 1 }))
    expect(refsA.read<{ seq: number }>('world')!.data.seq).toBe(2)
  })
})
