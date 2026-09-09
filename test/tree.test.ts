import { describe, expect, test, beforeAll } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { oidReady } from '../src/core/oids.ts'
import { ObjectStore } from '../src/core/objects.ts'
import { Trees, PathKindConflict } from '../src/core/tree.ts'
import { IgnoreRules, globToRegex } from '../src/core/ignore.ts'
import { assertNoCollisions, pathKey, validatePath, InvalidPathError } from '../src/core/paths.ts'

beforeAll(async () => {
  await oidReady()
})

function tmp(name: string): string {
  const dir = join(import.meta.dir, '.tmp', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

function newTrees(): { trees: Trees; store: ObjectStore; dir: string } {
  const dir = tmp(`tree-${Math.random().toString(36).slice(2)}`)
  const store = ObjectStore.open(join(dir, 'objects'))
  return { trees: new Trees(store), store, dir }
}

describe('portable paths', () => {
  test('rejects non-portable spellings', () => {
    for (const bad of ['/abs', 'trailing/', 'a//b', '.', '..', 'a/../b', 'a/./b', 'a\\b', 'a\0b']) {
      expect(() => validatePath(bad)).toThrow(InvalidPathError)
    }
    expect(() => validatePath('src/main.ts')).not.toThrow()
    expect(() => validatePath('über/datei.txt')).not.toThrow()
  })

  test('collisions are caught under the path key, original spelling is kept', () => {
    expect(pathKey('File.ts')).toBe(pathKey('file.ts'))
    expect(pathKey('e\u0301clair.md')).toBe(pathKey('éclair.md'))
    expect(() => assertNoCollisions(['src/Main.ts', 'src/main.ts'])).toThrow(InvalidPathError)
    expect(() => assertNoCollisions(['src/Main.ts', 'docs/main.ts'])).not.toThrow()
  })
})

describe('trees', () => {
  test('apply changes shares unchanged subtrees structurally', () => {
    const { trees, store } = newTrees()
    const blob = (s: string) => trees.putBlob(new TextEncoder().encode(s))

    const base = trees.applyChanges(null, new Map([
      ['src/a.ts', { kind: 'file', oid: blob('a') }],
      ['src/b.ts', { kind: 'file', oid: blob('b') }],
      ['docs/readme.md', { kind: 'file', oid: blob('readme') }],
    ]))

    const before = trees.listFiles(base)
    expect([...before.keys()].sort()).toEqual(['docs/readme.md', 'src/a.ts', 'src/b.ts'])

    // Change one file: the docs subtree must keep its identity.
    const srcDirBefore = trees.entry(base, 'src') // leaf lookup misses, dirs are transparent
    void srcDirBefore
    const docsTreeOidBefore = readDirOid(trees, base, 'docs')
    const changed = trees.applyChanges(base, new Map([
      ['src/a.ts', { kind: 'file', oid: blob('a2') }],
    ]))
    expect(readDirOid(trees, changed, 'docs').ref).toBe(docsTreeOidBefore.ref)
    expect(trees.entry(changed, 'src/a.ts')!.oid.ref).toBe(blob('a2').ref)
  })

  test('deletions prune empty directories', () => {
    const { trees } = newTrees()
    const blob = (s: string) => trees.putBlob(new TextEncoder().encode(s))
    const base = trees.applyChanges(null, new Map([
      ['only/inner/file.txt', { kind: 'file', oid: blob('x') }],
    ]))
    const after = trees.applyChanges(base, new Map([
      ['only/inner/file.txt', null],
    ]))
    expect(after.ref).toBe(trees.emptyTree().ref)
    expect(trees.listFiles(after).size).toBe(0)
  })

  test('nested creation colliding with an existing leaf is rejected', () => {
    const { trees } = newTrees()
    const blob = (s: string) => trees.putBlob(new TextEncoder().encode(s))
    const base = trees.applyChanges(null, new Map([
      ['a', { kind: 'file', oid: blob('leaf') }],
    ]))
    expect(() =>
      trees.applyChanges(base, new Map([['a/b', { kind: 'file', oid: blob('x') }]])),
    ).toThrow(PathKindConflict)
    // Explicit delete plus nested create is the well-formed form.
    const fixed = trees.applyChanges(base, new Map([
      ['a', null],
      ['a/b', { kind: 'file', oid: blob('x') }],
    ]))
    expect(trees.entry(fixed, 'a/b')).not.toBeNull()
    expect(trees.entry(fixed, 'a')).toBeNull()
  })

  test('diffPaths reports file-level differences including kind changes', () => {
    const { trees } = newTrees()
    const blob = (s: string) => trees.putBlob(new TextEncoder().encode(s))
    const link = trees.putSymlink('../target')
    const a = trees.applyChanges(null, new Map([
      ['keep.txt', { kind: 'file', oid: blob('keep') }],
      ['gone.txt', { kind: 'file', oid: blob('gone') }],
      ['mod.txt', { kind: 'file', oid: blob('v1') }],
      ['kind.txt', { kind: 'file', oid: blob('same-bytes') }],
      ['dir/inner.txt', { kind: 'file', oid: blob('inner') }],
    ]))
    const b = trees.applyChanges(a, new Map([
      ['gone.txt', null],
      ['mod.txt', { kind: 'file', oid: blob('v2') }],
      ['kind.txt', { kind: 'exec', oid: blob('same-bytes') }],
      ['dir', null],
      ['new/link', { kind: 'symlink', oid: link }],
    ]))
    const diff = trees.diffPaths(a, b)
    const byPath = new Map(diff.map((d) => [d.path, d]))
    expect(diff.map((d) => d.path).sort()).toEqual(['dir/inner.txt', 'gone.txt', 'kind.txt', 'mod.txt', 'new/link'])
    expect(byPath.get('gone.txt')!.after).toBeNull()
    expect(byPath.get('kind.txt')!.after!.kind).toBe('exec')
    expect(byPath.get('new/link')!.after!.kind).toBe('symlink')
    expect(byPath.get('dir/inner.txt')!.before).not.toBeNull()
  })
})

function readDirOid(trees: Trees, treeId: ReturnType<Trees['emptyTree']>, name: string) {
  const { dirs } = trees.readTree(treeId)
  const found = dirs.find((d) => d.name === name)
  if (!found) throw new Error(`dir ${name} not found`)
  return found.oid
}

describe('ignore rules', () => {
  test('common gitignore patterns behave as expected', () => {
    const rules = new IgnoreRules([
      '# comment',
      '',
      'node_modules/',
      '*.log',
      '/root-only.txt',
      'docs/*.md',
      '**/deep.txt',
      '!keep.log',
      'build',
    ])
    expect(rules.matched('node_modules', true)).toBe(true)
    expect(rules.matched('a/b/node_modules', true)).toBe(true)
    expect(rules.matched('node_modules/package.json')).toBe(false) // walker prunes the dir first
    expect(rules.matched('debug.log')).toBe(true)
    expect(rules.matched('sub/debug.log')).toBe(true)
    expect(rules.matched('root-only.txt')).toBe(true)
    expect(rules.matched('sub/root-only.txt')).toBe(false)
    expect(rules.matched('docs/guide.md')).toBe(true)
    expect(rules.matched('docs/sub/guide.md')).toBe(false)
    expect(rules.matched('a/deep.txt')).toBe(true)
    expect(rules.matched('deep.txt')).toBe(true)
    expect(rules.matched('keep.log')).toBe(false) // negated after *.log
    expect(rules.matched('a/keep.log')).toBe(false)
    expect(rules.matched('build', true)).toBe(true)
    expect(rules.matched('x/build', true)).toBe(true)
    expect(rules.matched('build', false)).toBe(true) // bare name matches files too
    expect(rules.matched('builder.ts')).toBe(false)
  })

  test('dir-only rules do not match files', () => {
    const rules = new IgnoreRules(['cache/'])
    expect(rules.matched('cache', true)).toBe(true)
    expect(rules.matched('cache', false)).toBe(false)
  })

  test('glob translation is deterministic', () => {
    expect(globToRegex('*.ts').test('a.ts')).toBe(true)
    expect(globToRegex('*.ts').test('a/b.ts')).toBe(false)
    expect(globToRegex('a?c').test('abc')).toBe(true)
    expect(globToRegex('a?c').test('ac')).toBe(false)
  })
})
