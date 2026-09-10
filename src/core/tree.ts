import { cborEncode, cborDecode, type CborValue } from './cbor.ts'
import { typedHash, Oid } from './oids.ts'
import { ObjectStore } from './objects.ts'
import { validatePath, assertNoCollisions } from './paths.ts'

// Trees are the fundamental state. A tree is an immutable, content-addressed
// directory record whose entries are sorted by UTF-8 bytes of the name, so
// unchanged subtrees are shared structurally between any two states. Diffs
// are derived comparisons between states, never stored as truth.

export type FileKind = 'file' | 'exec' | 'symlink'

export interface TreeEntry {
  name: string
  kind: FileKind
  // file: blob id; exec: blob id; symlink: symlink-record id; dir entries are
  // represented by kind 'dir' in the record, kept separate so the union above
  // stays about leaves. Trees carry child Oids directly on directory records.
  oid: Oid
}

export interface DirEntry {
  name: string
  entries: TreeEntry[] | DirEntry[]
}

const encoder = new TextEncoder()

export function compareNames(a: string, b: string): number {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1
  }
  return x.length - y.length
}

interface TreeRecord {
  v: 1
  leaves: Array<{ n: string; k: FileKind; o: Uint8Array }>
  dirs: Array<{ n: string; o: Uint8Array }>
}

type Change = { kind: FileKind; oid: Oid } | null

export class PathKindConflict extends Error {
  constructor(readonly path: string) {
    super(`path ${path} would need to be both a file and a directory`)
  }
}

export class Trees {
  private emptyId: Oid | null = null

  constructor(private store: ObjectStore) {}

  emptyTree(): Oid {
    return (this.emptyId ??= this.writeTree([], []))
  }

  putBlob(bytes: Uint8Array): Oid {
    return this.store.put('file', bytes)
  }

  readBlob(id: Oid): Uint8Array {
    return this.store.get(id)
  }

  putSymlink(target: string): Oid {
    return this.store.put('symlink', encoder.encode(target))
  }

  readSymlink(id: Oid): string {
    return new TextDecoder().decode(this.store.get(id))
  }

  writeTree(leaves: TreeEntry[], dirs: Array<{ name: string; oid: Oid }>): Oid {
    const sortedLeaves = [...leaves].sort((a, b) => compareNames(a.name, b.name))
    const sortedDirs = [...dirs].sort((a, b) => compareNames(a.name, b.name))
    const record: TreeRecord = {
      v: 1,
      leaves: sortedLeaves.map((e) => ({ n: e.name, k: e.kind, o: e.oid.bytes })),
      dirs: sortedDirs.map((d) => ({ n: d.name, o: d.oid.bytes })),
    }
    return this.store.put('tree', cborEncode(record as unknown as CborValue))
  }

  readTree(id: Oid): { leaves: TreeEntry[]; dirs: Array<{ name: string; oid: Oid }> } {
    const bytes = this.store.get(id)
    if (!typedHash('tree', bytes, id.algo).equals(id)) {
      throw new Error(`tree ${id.ref} is corrupted`)
    }
    const rec = cborDecode(bytes) as unknown as TreeRecord
    return {
      leaves: rec.leaves.map((l) => ({ name: l.n, kind: l.k, oid: Oid.fromBytes(l.o) })),
      dirs: rec.dirs.map((d) => ({ name: d.n, oid: Oid.fromBytes(d.o) })),
    }
  }

  // Resolve one path to its entry. Returns the containing information only
  // for leaves; intermediate directories are traversed transparently.
  entry(treeId: Oid, path: string): TreeEntry | null {
    validatePath(path)
    const segments = path.split('/')
    let current: Oid | null = treeId
    for (let i = 0; i < segments.length; i++) {
      if (!current) return null
      const { leaves, dirs } = this.readTree(current)
      const last = i === segments.length - 1
      const seg = segments[i]!
      const leaf = leaves.find((e) => e.name === seg)
      if (leaf) {
        if (last) return leaf
        return null
      }
      const dir = dirs.find((e) => e.name === seg)
      current = dir?.oid ?? null
      if (last) return null
    }
    return null
  }

  // Apply a change set (path -> new leaf state or null for delete) onto a
  // base tree. Only nodes along changed paths are rewritten; everything else
  // is shared with the base.
  applyChanges(base: Oid | null, changes: Map<string, Change>): Oid {
    for (const path of changes.keys()) validatePath(path)
    assertNoCollisions(changes.keys())
    return this.applyInto(base ?? this.emptyTree(), changes)
  }

  private applyInto(base: Oid, changes: Map<string, Change>): Oid {
    if (changes.size === 0) return base
    const { leaves, dirs } = this.readTree(base)

    const local: Array<[string, Change]> = []
    const nested = new Map<string, Map<string, Change>>()
    for (const [path, change] of changes) {
      const slash = path.indexOf('/')
      if (slash === -1) local.push([path, change])
      else {
        const head = path.slice(0, slash)
        const rest = path.slice(slash + 1)
        let sub = nested.get(head)
        if (!sub) nested.set(head, (sub = new Map()))
        sub.set(rest, change)
      }
    }

    const nextLeaves = leaves.filter((e) => !local.some(([n]) => n === e.name))
    for (const name of nested.keys()) {
      const survivor = leaves.find((e) => e.name === name)
      if (survivor && !local.some(([n, c]) => n === name && c === null)) {
        throw new PathKindConflict(name)
      }
    }
    const nextDirs: Array<{ name: string; oid: Oid }> = []
    for (const d of dirs) {
      const sub = nested.get(d.name)
      if (sub) {
        const localLeaf = local.find(([n]) => n === d.name)
        const emptied = this.applyInto(d.oid, sub)
        if (localLeaf && localLeaf[1] !== null) {
          // A leaf replaces the directory. This composes only when the
          // nested change set empties the directory completely.
          if (!emptied.equals(this.emptyTree())) throw new PathKindConflict(d.name)
          nested.delete(d.name)
          continue
        }
        nextDirs.push({ name: d.name, oid: emptied })
        nested.delete(d.name)
      } else if (local.some(([n, c]) => n === d.name && c === null)) {
        // deleting a whole subtree
      } else if (local.some(([n]) => n === d.name)) {
        throw new PathKindConflict(d.name)
      } else {
        nextDirs.push(d)
      }
    }

    for (const [name, change] of local) {
      if (change) nextLeaves.push({ name, kind: change.kind, oid: change.oid })
    }
    for (const [name, sub] of nested) {
      const child = this.applyInto(this.emptyTree(), sub)
      if (!child.equals(this.emptyTree())) {
        nextDirs.push({ name, oid: child })
      }
    }

    const prunedDirs = nextDirs.filter((d) => !this.isEmptyTree(d.oid))
    if (prunedDirs.length === 0 && nextLeaves.length === 0) return this.emptyTree()
    return this.writeTree(nextLeaves, prunedDirs)
  }

  private isEmptyTree(id: Oid): boolean {
    const { leaves, dirs } = this.readTree(id)
    return leaves.length === 0 && dirs.length === 0
  }

  listFiles(treeId: Oid, prefix = ''): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>()
    this.walk(treeId, prefix, (path, entry) => out.set(path, entry))
    return out
  }

  private walk(treeId: Oid, prefix: string, visit: (path: string, e: TreeEntry) => void): void {
    const { leaves, dirs } = this.readTree(treeId)
    for (const leaf of leaves) visit(prefix + leaf.name, leaf)
    for (const dir of dirs) this.walk(dir.oid, `${prefix}${dir.name}/`, visit)
  }

  // Derive the difference between two states at leaf granularity. This is a
  // comparison, computed on demand; nothing here is durable truth.
  diffPaths(
    a: Oid | null,
    b: Oid | null,
  ): Array<{ path: string; before: TreeEntry | null; after: TreeEntry | null }> {
    const out: Array<{ path: string; before: TreeEntry | null; after: TreeEntry | null }> = []
    this.diffInto(a, b, '', out)
    return out
  }

  private diffInto(
    a: Oid | null,
    b: Oid | null,
    prefix: string,
    out: Array<{ path: string; before: TreeEntry | null; after: TreeEntry | null }>,
  ): void {
    const A = a ? this.readTree(a) : { leaves: [], dirs: [] }
    const B = b ? this.readTree(b) : { leaves: [], dirs: [] }
    const names = new Set<string>([
      ...A.leaves.map((e) => e.name),
      ...A.dirs.map((e) => e.name),
      ...B.leaves.map((e) => e.name),
      ...B.dirs.map((e) => e.name),
    ])
    const sorted = [...names].sort(compareNames)
    for (const name of sorted) {
      const aLeaf = A.leaves.find((e) => e.name === name) ?? null
      const aDir = A.dirs.find((e) => e.name === name) ?? null
      const bLeaf = B.leaves.find((e) => e.name === name) ?? null
      const bDir = B.dirs.find((e) => e.name === name) ?? null
      const path = prefix + name
      if (aDir && bDir) {
        if (!aDir.oid.equals(bDir.oid)) this.diffInto(aDir.oid, bDir.oid, `${path}/`, out)
      } else if (aLeaf && bLeaf) {
        if (!aLeaf.oid.equals(bLeaf.oid) || aLeaf.kind !== bLeaf.kind) {
          out.push({ path, before: aLeaf, after: bLeaf })
        }
      } else if (aDir && bLeaf) {
        out.push({ path, before: null, after: bLeaf })
        this.walkDeletions(aDir.oid, `${path}/`, out, 'before')
      } else if (aLeaf && bDir) {
        out.push({ path, before: aLeaf, after: null })
        this.walkAdditions(bDir.oid, `${path}/`, out, 'after')
      } else if (aDir) {
        this.walkDeletions(aDir.oid, `${path}/`, out, 'before')
      } else if (bDir) {
        this.walkAdditions(bDir.oid, `${path}/`, out, 'after')
      } else if (aLeaf || bLeaf) {
        out.push({ path, before: aLeaf, after: bLeaf })
      }
    }
  }

  private walkDeletions(
    treeId: Oid,
    prefix: string,
    out: Array<{ path: string; before: TreeEntry | null; after: TreeEntry | null }>,
    side: 'before',
  ): void {
    const { leaves, dirs } = this.readTree(treeId)
    for (const leaf of leaves) {
      out.push({ path: prefix + leaf.name, before: leaf, after: null })
    }
    for (const dir of dirs) this.walkDeletions(dir.oid, `${prefix}${dir.name}/`, out, side)
  }

  private walkAdditions(
    treeId: Oid,
    prefix: string,
    out: Array<{ path: string; before: TreeEntry | null; after: TreeEntry | null }>,
    side: 'after',
  ): void {
    const { leaves, dirs } = this.readTree(treeId)
    for (const leaf of leaves) {
      out.push({ path: prefix + leaf.name, before: null, after: leaf })
    }
    for (const dir of dirs) this.walkAdditions(dir.oid, `${prefix}${dir.name}/`, out, side)
  }
}
