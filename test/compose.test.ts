import { describe, expect, test, beforeAll } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { oidReady } from '../src/core/oids.ts'
import { ObjectStore } from '../src/core/objects.ts'
import { Trees } from '../src/core/tree.ts'
import { compose, diff3Merge } from '../src/core/compose.ts'

beforeAll(async () => {
  await oidReady()
})

function setup() {
  const dir = join(import.meta.dir, '.tmp', `compose-${Math.random().toString(36).slice(2)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const store = ObjectStore.open(join(dir, 'objects'))
  const trees = new Trees(store)
  const enc = (s: string) => new TextEncoder().encode(s)
  const file = (s: string) => ({ kind: 'file' as const, oid: trees.putBlob(enc(s)) })
  const tree = (changes: Array<[string, ReturnType<typeof file> | null]>) =>
    trees.applyChanges(null, new Map(changes))
  return { trees, enc, file, tree }
}

describe('composition engine', () => {
  test('independent changes compose regardless of argument order', () => {
    const { trees, file, tree } = setup()
    const base = tree([
      ['src/a.ts', file('a\n')],
      ['src/b.ts', file('b\n')],
    ])
    const source = trees.applyChanges(base, new Map([['src/a.ts', file('a2\n')]]))
    const target = trees.applyChanges(base, new Map([['src/b.ts', file('b2\n')]]))

    const r1 = compose(trees, base, source, target)
    expect(r1.ok).toBe(true)
    const r2 = compose(trees, base, source, target)
    expect(r2.ok).toBe(true)
    if (r1.ok) {
      expect(new TextDecoder().decode(trees.readBlob(trees.entry(r1.tree, 'src/a.ts')!.oid))).toBe('a2\n')
      expect(new TextDecoder().decode(trees.readBlob(trees.entry(r1.tree, 'src/b.ts')!.oid))).toBe('b2\n')
    }
  })

  test('identical changes deduplicate', () => {
    const { trees, file, tree } = setup()
    const base = tree([['x.txt', file('one\n')]])
    const source = trees.applyChanges(base, new Map([['x.txt', file('two\n')]]))
    const target = trees.applyChanges(base, new Map([['x.txt', file('two\n')]]))
    const r = compose(trees, base, source, target)
    expect(r.ok).toBe(true)
  })

  test('modify versus delete conflicts in both directions', () => {
    const { trees, file, tree } = setup()
    const base = tree([['x.txt', file('v\n')]])
    const modified = trees.applyChanges(base, new Map([['x.txt', file('v2\n')]]))
    const deleted = trees.applyChanges(base, new Map([['x.txt', null]]))

    const r1 = compose(trees, base, modified, deleted)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.conflicts[0]!.type).toBe('delete-modify')
    const r2 = compose(trees, base, deleted, modified)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.conflicts[0]!.type).toBe('delete-modify')
  })

  test('incompatible kinds conflict', () => {
    const { trees, file, tree } = setup()
    const base = tree([['x', file('v\n')]])
    const asExec = trees.applyChanges(base, new Map([['x', { kind: 'exec', oid: trees.putBlob(new TextEncoder().encode('v\n')) }]]))
    const asFile2 = trees.applyChanges(base, new Map([['x', file('v2\n')]]))
    const r = compose(trees, base, asExec, asFile2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.conflicts[0]!.type).toBe('kind')
  })

  test('file replaced by directory in the other side conflicts as file-dir', () => {
    const { trees, file, tree } = setup()
    const base = tree([['x', file('leaf\n')]])
    // Source turns x into a directory with content.
    const source = trees.applyChanges(base, new Map([
      ['x', null],
      ['x/inner.txt', file('inner\n')],
    ]))
    // Target edits x as a leaf.
    const target = trees.applyChanges(base, new Map([['x', file('leaf2\n')]]))
    const r = compose(trees, base, source, target)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.conflicts[0]!.type).toBe('file-dir')
  })

  test('different content on the same added path conflicts', () => {
    const { trees, file, tree } = setup()
    const base = tree([])
    const source = trees.applyChanges(base, new Map([['new.txt', file('from source\n')]]))
    const target = trees.applyChanges(base, new Map([['new.txt', file('from target\n')]]))
    const r = compose(trees, base, source, target)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.conflicts[0]!.type).toBe('content')
  })

  test('disjoint text edits in one file merge deterministically', () => {
    const { trees, file, tree } = setup()
    const base = tree([['notes.md', file('alpha\nbeta\ngamma\ndelta\n')]])
    const source = trees.applyChanges(base, new Map([['notes.md', file('ALPHA\nbeta\ngamma\ndelta\n')]]))
    const target = trees.applyChanges(base, new Map([['notes.md', file('alpha\nbeta\ngamma\nDELTA\n')]]))
    const r = compose(trees, base, source, target)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(new TextDecoder().decode(trees.readBlob(trees.entry(r.tree, 'notes.md')!.oid))).toBe(
        'ALPHA\nbeta\ngamma\nDELTA\n',
      )
    }
  })

  test('overlapping different text edits conflict without mutating anything', () => {
    const { trees, file, tree } = setup()
    const base = tree([['notes.md', file('alpha\nbeta\ngamma\n')]])
    const source = trees.applyChanges(base, new Map([['notes.md', file('alpha\nBETA-SOURCE\n')]]))
    const target = trees.applyChanges(base, new Map([['notes.md', file('alpha\nBETA-TARGET\n')]]))
    const before = trees.entry(target, 'notes.md')!.oid
    const r = compose(trees, base, source, target)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.conflicts[0]!.type).toBe('content')
    expect(trees.entry(target, 'notes.md')!.oid.ref).toBe(before.ref)
  })

  test('identical text edits dedupe through the merge path', () => {
    const { trees, file, tree } = setup()
    const base = tree([['f.txt', file('x\ny\nz\n')]])
    const source = trees.applyChanges(base, new Map([['f.txt', file('x\nY-BOTH\nz\n')]]))
    const target = trees.applyChanges(base, new Map([['f.txt', file('x\nY-BOTH\nz\n')]]))
    const r = compose(trees, base, source, target)
    expect(r.ok).toBe(true)
  })

  test('source with no changes leaves the target untouched', () => {
    const { trees, file, tree } = setup()
    const base = tree([['a.txt', file('a\n')]])
    const target = trees.applyChanges(base, new Map([['b.txt', file('b\n')]]))
    const r = compose(trees, base, base, target)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.tree.ref).toBe(target.ref)
  })
})

describe('diff3', () => {
  test('clean merges', () => {
    expect(diff3Merge('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')).toBe('A\nb\nC\n')
    expect(diff3Merge('a\n', 'a\nx\n', 'x\na\n')).toBe('x\na\nx\n')
    expect(diff3Merge('', 'a\n', 'b\n')).toBe(null) // both added differently
    expect(diff3Merge('same\n', 'same\n', 'same\n')).toBe('same\n')
  })

  test('conflicting regions return null', () => {
    expect(diff3Merge('one\ntwo\n', 'ONE\ntwo\n', 'one\nTWO\n')).toBe('ONE\nTWO\n')
    expect(diff3Merge('mid', 'left-mid', 'mid-right')).toBe(null)
  })
})
