// Deterministic three-state composition: derive what the source changed
// relative to a shared base, then attempt to apply exactly that onto the
// target. Independent changes compose; identical changes dedupe; ambiguous
// overlaps become structured conflicts. The engine never invents content:
// every output byte comes from one of the three inputs. Stack and Publish
// call this same engine.

import { Oid } from './oids.ts'
import { Trees, type TreeEntry, type FileKind, PathKindConflict } from './tree.ts'

export type ConflictType = 'content' | 'delete-modify' | 'kind' | 'file-dir'

export interface Conflict {
  path: string
  type: ConflictType
  detail: string
}

export type ComposeResult =
  | { ok: true; tree: Oid; changedPaths: string[] }
  | { ok: false; conflicts: Conflict[] }

export function compose(
  trees: Trees,
  base: Oid | null,
  source: Oid | null,
  target: Oid | null,
): ComposeResult {
  const srcChanges = trees.diffPaths(base, source)
  if (srcChanges.length === 0) {
    return { ok: true, tree: target ?? trees.emptyTree(), changedPaths: [] }
  }
  const tgtChanges = trees.diffPaths(base, target)
  const srcByPath = new Map(srcChanges.map((c) => [c.path, c]))
  const tgtByPath = new Map(tgtChanges.map((c) => [c.path, c]))

  const conflicts: Conflict[] = []
  const apply = new Map<string, { kind: FileKind; oid: Oid } | null>()

  for (const [path, src] of srcByPath) {
    const tgt = tgtByPath.get(path)
    if (!tgt) {
      apply.set(path, toChange(src.after))
      continue
    }
    if (sameState(src.after, tgt.after)) continue
    if (src.after === null && tgt.after !== null) {
      const reclassified = hasChildren(srcByPath, path) ? 'file-dir' : 'delete-modify'
      conflicts.push({
        path,
        type: reclassified,
        detail: reclassified === 'file-dir'
          ? 'source replaces this leaf with directory content, target modified the leaf'
          : 'source deleted, target modified',
      })
    } else if (tgt.after === null && src.after !== null) {
      const reclassified = hasChildren(tgtByPath, path) ? 'file-dir' : 'delete-modify'
      conflicts.push({
        path,
        type: reclassified,
        detail: reclassified === 'file-dir'
          ? 'target replaces this leaf with directory content, source modified the leaf'
          : 'target deleted, source modified',
      })
    } else if (src.after === null || tgt.after === null) {
      continue
    } else if (src.after.kind !== tgt.after.kind) {
      conflicts.push({
        path,
        type: 'kind',
        detail: `source is ${src.after.kind}, target is ${tgt.after.kind}`,
      })
    } else {
      const merged = tryMergeText(trees, src, tgt)
      if (merged) apply.set(path, { kind: src.after.kind, oid: merged })
      else {
        conflicts.push({
          path,
          type: 'content',
          detail: 'same path requires different final content',
        })
      }
    }
  }

  if (conflicts.length === 0) conflicts.push(...fileDirConflicts(srcChanges, tgtChanges))
  if (conflicts.length > 0) return { ok: false, conflicts }

  try {
    const tree = trees.applyChanges(target ?? trees.emptyTree(), apply)
    return { ok: true, tree, changedPaths: [...apply.keys()].sort() }
  } catch (e) {
    if (e instanceof PathKindConflict) {
      return {
        ok: false,
        conflicts: [
          { path: e.path, type: 'file-dir', detail: 'path would need to be both a file and a directory' },
        ],
      }
    }
    throw e
  }
}

// One side turns a path into (or keeps) directory content while the other
// side wants a leaf (or an absence) at that exact path.
function fileDirConflicts(
  srcChanges: Array<{ path: string; after: TreeEntry | null }>,
  tgtChanges: Array<{ path: string; after: TreeEntry | null }>,
): Conflict[] {
  const conflicts: Conflict[] = []
  const prefixIn = (changes: Array<{ path: string }>, dir: string): string | null => {
    const prefix = `${dir}/`
    for (const c of changes) if (c.path.startsWith(prefix)) return c.path
    return null
  }
  for (const src of srcChanges) {
    const under = prefixIn(tgtChanges, src.path)
    if (under) {
      conflicts.push({
        path: src.path,
        type: 'file-dir',
        detail: `source sets ${src.path} as ${src.after === null ? 'absent' : src.after.kind}, target changes ${under} beneath it`,
      })
    }
  }
  for (const tgt of tgtChanges) {
    const under = prefixIn(srcChanges, tgt.path)
    if (under) {
      conflicts.push({
        path: tgt.path,
        type: 'file-dir',
        detail: `target sets ${tgt.path} as ${tgt.after === null ? 'absent' : tgt.after.kind}, source changes ${under} beneath it`,
      })
    }
  }
  return conflicts
}

function toChange(e: TreeEntry | null): { kind: FileKind; oid: Oid } | null {
  return e ? { kind: e.kind, oid: e.oid } : null
}

function hasChildren(
  changes: Map<string, { path: string }>,
  dir: string,
): boolean {
  const prefix = `${dir}/`
  for (const key of changes.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

function sameState(a: TreeEntry | null, b: TreeEntry | null): boolean {
  if (a === null || b === null) return a === null && b === null
  return a.kind === b.kind && a.oid.equals(b.oid)
}

function tryMergeText(trees: Trees, src: { path: string; before: TreeEntry | null; after: TreeEntry | null }, tgt: { before: TreeEntry | null; after: TreeEntry | null }): Oid | null {
  const kind = src.after!.kind
  if (kind !== 'file' && kind !== 'exec') return null
  if (tgt.after!.kind !== 'file' && tgt.after!.kind !== 'exec') return null
  if (src.before === null || tgt.before === null) return null
  if (!src.before.oid.equals(tgt.before.oid)) return null
  const base = decodeText(trees.readBlob(src.before.oid))
  const source = decodeText(trees.readBlob(src.after!.oid))
  const target = decodeText(trees.readBlob(tgt.after!.oid))
  if (base === null || source === null || target === null) return null
  const merged = diff3Merge(base, source, target)
  return merged === null ? null : trees.putBlob(new TextEncoder().encode(merged))
}

function decodeText(bytes: Uint8Array): string | null {
  for (const b of bytes) if (b === 0) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

// Line-level diff3 over a Myers two-way diff. Returns merged text, or null
// when some region cannot be resolved deterministically.

export function myersMatch(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []
  let foundD = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!
      } else {
        x = v[offset + k - 1]! + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        foundD = d
        break
      }
    }
    if (foundD >= 0) break
  }
  if (foundD < 0) return []

  const matches: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = foundD; d > 0; d--) {
    const vPrev = trace[d - 1]!
    const k = x - y
    const down = k === -d || (k !== d && vPrev[offset + k - 1]! < vPrev[offset + k + 1]!)
    while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
      matches.push([x - 1, y - 1])
      x--
      y--
    }
    if (down) y--
    else x--
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    matches.push([x - 1, y - 1])
    x--
    y--
  }
  matches.reverse()
  return matches
}

function splitLines(text: string): string[] {
  if (text === '') return []
  return text.split('\n').map((line, i, arr) => (i < arr.length - 1 ? `${line}\n` : line))
}

interface Hunk {
  b0: number
  b1: number
  o0: number
  o1: number
}

function hunksFromMatches(matches: Array<[number, number]>, baseLen: number, otherLen: number): Hunk[] {
  const hunks: Hunk[] = []
  let pi = 0
  let pj = 0
  for (const [mi, mj] of matches) {
    if (mi > pi || mj > pj) hunks.push({ b0: pi, b1: mi, o0: pj, o1: mj })
    pi = mi + 1
    pj = mj + 1
  }
  if (pi < baseLen || pj < otherLen) hunks.push({ b0: pi, b1: baseLen, o0: pj, o1: otherLen })
  return hunks
}

interface Region {
  stable: boolean
  b0: number
  b1: number
  s0: number
  s1: number
  t0: number
  t1: number
}

// Build diff3 regions from the two two-way edit scripts. Stable regions are
// 1:1 in all three inputs; each unstable region carries the exact source and
// target ranges consumed by its overlapping or disjoint hunks.
function diff3Regions(base: string[], source: string[], target: string[]): Region[] {
  const hunksS = hunksFromMatches(myersMatch(base, source), base.length, source.length)
  const hunksT = hunksFromMatches(myersMatch(base, target), base.length, target.length)
  const regions: Region[] = []
  let si = 0
  let ti = 0
  let r = 0
  let s = 0
  let t = 0

  const emitStable = (to: number): void => {
    if (to > r) regions.push({ stable: true, b0: r, b1: to, s0: s, s1: s + (to - r), t0: t, t1: t + (to - r) })
  }

  for (;;) {
    const curS = hunksS[si]
    const curT = hunksT[ti]
    if (!curS && !curT) {
      emitStable(base.length)
      break
    }
    const start = Math.min(curS ? curS.b0 : Number.MAX_SAFE_INTEGER, curT ? curT.b0 : Number.MAX_SAFE_INTEGER)
    emitStable(start)
    let end = start
    let useS = false
    let useT = false
    if (curS && curS.b0 === start) {
      useS = true
      end = Math.max(end, curS.b1)
    }
    if (curT && curT.b0 === start) {
      useT = true
      end = Math.max(end, curT.b1)
    }
    for (;;) {
      let grew = false
      if (curS && !useS && curS.b0 < end) {
        end = Math.max(end, curS.b1)
        useS = true
        grew = true
      }
      if (curT && !useT && curT.b0 < end) {
        end = Math.max(end, curT.b1)
        useT = true
        grew = true
      }
      if (!grew) break
    }
    const sStart = s + (start - r)
    const tStart = t + (start - r)
    let sEnd = sStart + (end - start)
    let tEnd = tStart + (end - start)
    if (useS && curS) {
      sEnd = sStart + (end - start) + (curS.o1 - curS.o0 - (curS.b1 - curS.b0))
      if (curS.b1 > end) end = curS.b1
    }
    if (useT && curT) {
      tEnd = tStart + (end - start) + (curT.o1 - curT.o0 - (curT.b1 - curT.b0))
      if (curT.b1 > end) end = curT.b1
    }
    regions.push({ stable: false, b0: start, b1: end, s0: sStart, s1: sEnd, t0: tStart, t1: tEnd })
    if (useS) si++
    if (useT) ti++
    r = end
    s = sEnd
    t = tEnd
  }
  return regions
}

export function diff3Merge(baseText: string, sourceText: string, targetText: string): string | null {
  const base = splitLines(baseText)
  const source = splitLines(sourceText)
  const target = splitLines(targetText)
  const out: string[] = []
  for (const c of diff3Regions(base, source, target)) {
    if (c.stable) {
      out.push(...lines(base, c.b0, c.b1))
      continue
    }
    const bSeg = textOf(base, c.b0, c.b1)
    const sSeg = textOf(source, c.s0, c.s1)
    const tSeg = textOf(target, c.t0, c.t1)
    if (sSeg === bSeg) out.push(...lines(target, c.t0, c.t1))
    else if (tSeg === bSeg) out.push(...lines(source, c.s0, c.s1))
    else if (sSeg === tSeg) out.push(...lines(source, c.s0, c.s1))
    else return null
  }
  return out.join('')
}

function lines(text: string[], a: number, b: number): string[] {
  const out: string[] = []
  for (let i = a; i < b; i++) out.push(text[i]!)
  return out
}

function textOf(text: string[], a: number, b: number): string {
  return lines(text, a, b).join('')
}
