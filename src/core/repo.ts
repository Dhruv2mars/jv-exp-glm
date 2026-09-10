import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, lstatSync, rmSync, rmdirSync, writeFileSync, symlinkSync, chmodSync, renameSync } from 'node:fs'

// existsSync follows symlinks and reports a broken link as absent, which
// makes seal oscillate between storing and deleting it. lstat looks at the
// link itself.
function pathPresent(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cborEncode, type CborValue } from './cbor.ts'
import { Oid, typedHash, oidReady } from './oids.ts'
import { ObjectStore } from './objects.ts'
import { Trees, type FileKind, type TreeEntry } from './tree.ts'
import { compose, type Conflict } from './compose.ts'
import { Refs, CasConflict } from './refs.ts'
import { Timeline } from './timeline.ts'
import { IgnoreRules, translateGitignore } from './ignore.ts'
import { scanTraceForSecrets } from './secrets.ts'
import { validatePath, assertNoCollisions } from './paths.ts'

export type Change = { kind: FileKind; oid: Oid } | null

interface StatIndexEntry {
  m: number
  s: number
  i: number
  kind: FileKind
  oid: string
}

export interface WorldRefData {
  v: 1
  seq: number
  head: string
}

export interface WorldVersionRecord {
  v: 1
  seq: number
  parent: string | null
  codeTree: string
  contextRoot: string | null
  layerId: string
  layerName: string
  publishedAt: string
  note?: string
  missingContextOverride?: boolean
}

export interface SubtaskRecord {
  taskId: string
  agentType: string
  chunks: string[]
  childLayer?: string
  startedAt: string
}

export interface LayerRecord {
  v: 1
  id: string
  name: string
  baseSeq: number
  baseVersion: string
  baseTree: string
  status: 'active' | 'ready' | 'published'
  savedRoot: string | null
  parent: string | null
  createdAt: string
  agent: { type: string; sessionId: string } | null
  chunks: string[]
  subtasks: SubtaskRecord[]
  endedAt: string | null
  publishedAs: string | null
}

export interface PublishResult {
  status: 'published'
  seq: number
  version: string
  changedPaths: string[]
}

export interface StackResult {
  status: 'stacked'
  target: string
  sources: string[]
  changedPaths: string[]
}

export interface ConflictResult {
  status: 'conflict'
  target: string
  sources: string[]
  conflicts: Conflict[]
}

export class RepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

const LATEST_SCAN_LIMIT = 16
const OP_STALE_MS = 30_000
const TEMPLATE_CACHE_SIZE = 4

// Directory copy that uses APFS clonefile (cp -c) when available, so a
// materialized workspace shares blocks with its template until edited.
// Falls back to a plain copy everywhere else or when cloning fails.
function copyTree(src: string, dest: string): void {
  const args = process.platform === 'darwin' ? ['-Rc', '-p'] : ['-R', '-p']
  let result = Bun.spawnSync(['cp', ...args, src, dest], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0 && args[0] === '-Rc') {
    result = Bun.spawnSync(['cp', '-R', '-p', src, dest], { stdout: 'pipe', stderr: 'pipe' })
  }
  if (result.exitCode !== 0) {
    throw new RepositoryError('error', `failed to materialize ${dest}: ${result.stderr.toString().trim()}`)
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class Repo {
  readonly metaDir: string
  readonly store: ObjectStore
  readonly trees: Trees
  readonly refs: Refs
  readonly timeline: Timeline

  private constructor(readonly projectDir: string) {
    this.metaDir = join(projectDir, '.javelin')
    this.store = ObjectStore.open(join(this.metaDir, 'objects'))
    this.trees = new Trees(this.store)
    this.refs = Refs.open(this.metaDir)
    this.timeline = new Timeline(this.metaDir)
  }

  static async open(projectDir: string): Promise<Repo> {
    await oidReady()
    if (!existsSync(join(projectDir, '.javelin'))) {
      throw new RepositoryError('not-a-repository', `${projectDir} is not a javelin repository`)
    }
    return new Repo(projectDir)
  }

  static async init(projectDir: string, opts?: { note?: string }): Promise<Repo> {
    await oidReady()
    const metaDir = join(projectDir, '.javelin')
    if (existsSync(metaDir)) {
      throw new RepositoryError('already-a-repository', `${projectDir} already has a .javelin`)
    }
    if (existsSync(join(projectDir, '.git'))) {
      throw new RepositoryError(
        'git-repository',
        `${projectDir} is a Git repository; javelin is a clean alternative, not a layer on top of it. Remove .git or init a different folder.`,
      )
    }
    mkdirSync(join(metaDir, 'objects'), { recursive: true })
    mkdirSync(join(metaDir, 'refs'), { recursive: true })
    mkdirSync(join(metaDir, 'locks'), { recursive: true })
    mkdirSync(join(metaDir, 'workspaces'), { recursive: true })

    const gitignore = join(projectDir, '.gitignore')
    const javelinignore = join(projectDir, '.javelinignore')
    if (!existsSync(javelinignore) && existsSync(gitignore)) {
      writeFileSync(javelinignore, translateGitignore(readFileSync(gitignore, 'utf8')))
    }

    const repo = new Repo(projectDir)
    const changes = repo.scanTree(projectDir, null, IgnoreRules.load(projectDir))
    const tree = repo.trees.applyChanges(null, changes)
    const record: WorldVersionRecord = {
      v: 1,
      seq: 1,
      parent: null,
      codeTree: tree.ref,
      contextRoot: null,
      layerId: 'init',
      layerName: 'init',
      publishedAt: new Date().toISOString(),
      ...(opts?.note ? { note: opts.note } : {}),
    }
    const { id } = repo.putWorldRecord(record)
    repo.refs.init('world', { v: 1, seq: 1, head: id.ref } satisfies WorldRefData)
    repo.timeline.append('world.initialized', { version: id.ref, seq: '1' })
    return repo
  }

  // ---- world ----

  worldRef(): { gen: number; data: WorldRefData } {
    const entry = this.refs.read<WorldRefData>('world')
    if (!entry) throw new RepositoryError('corruption', 'world reference is missing')
    return entry
  }

  worldRecord(ref = this.worldRef().data.head): WorldVersionRecord {
    const { record } = this.store.getRecord('world-version', Oid.parse(ref))
    return record as unknown as WorldVersionRecord
  }

  private putWorldRecord(record: WorldVersionRecord): { id: Oid } {
    const { id } = this.store.putRecord('world-version', record as unknown as CborValue)
    return { id }
  }

  private putContext(record: CborValue): Oid {
    return this.store.put('context-root', cborEncode(record))
  }

  historyEntries(limit?: number): Array<{ id: string; record: WorldVersionRecord }> {
    const out: Array<{ id: string; record: WorldVersionRecord }> = []
    let ref: string | null = this.worldRef().data.head
    while (ref && (limit === undefined || out.length < limit)) {
      const record = this.worldRecord(ref)
      out.push({ id: ref, record })
      ref = record.parent
    }
    return out
  }

  history(limit?: number): WorldVersionRecord[] {
    return this.historyEntries(limit).map((e) => e.record)
  }

  // ---- layers ----

  layerNames(): string[] {
    const dir = join(this.metaDir, 'refs', 'layers')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((name) => !name.includes('.tmp-')).sort()
  }

  layer(name: string): LayerRecord {
    const entry = this.refs.read<LayerRecord>(`layers/${name}`)
    if (!entry) throw new RepositoryError('not-found', `layer ${name} does not exist`)
    return entry.data
  }

  private updateLayer(name: string, mutate: (record: LayerRecord) => LayerRecord): LayerRecord {
    const entry = this.refs.update<LayerRecord>(
      `layers/${name}`,
      (d) => {
        if (!d) throw new RepositoryError('not-found', `layer ${name} does not exist`)
        return mutate(d)
      },
      { fsyncDir: true },
    )
    return entry.data
  }

  workspacePath(name: string): string {
    return join(this.metaDir, 'workspaces', name)
  }

  async layerCreate(name: string, opts?: { parent?: string; agent?: { type: string; sessionId: string } }): Promise<LayerRecord> {
    validateLayerName(name)
    if (this.refs.read(`layers/${name}`)) {
      throw new RepositoryError('exists', `layer ${name} already exists`)
    }
    if (opts?.parent) {
      const parent = this.layer(opts.parent)
      if (parent.status === 'published') {
        throw new RepositoryError('published-parent', `parent layer ${opts.parent} is published`)
      }
    }
    const world = this.worldRef().data
    const baseRecord = this.worldRecord(world.head)
    const record: LayerRecord = {
      v: 1,
      id: randomUUID(),
      name,
      baseSeq: world.seq,
      baseVersion: world.head,
      baseTree: baseRecord.codeTree,
      status: 'active',
      savedRoot: null,
      parent: opts?.parent ?? null,
      createdAt: new Date().toISOString(),
      agent: opts?.agent ?? null,
      chunks: [],
      subtasks: [],
      endedAt: null,
      publishedAs: null,
    }
    this.refs.init(`layers/${name}`, record)
    this.materializeWorkspace(name, Oid.parse(baseRecord.codeTree))
    this.timeline.append('layer.created', {
      layer: name,
      base: `v${world.seq}`,
      ...(opts?.parent ? { parent: opts.parent } : {}),
    })
    return record
  }

  layerClone(srcName: string, dstName: string): LayerRecord {
    validateLayerName(dstName)
    if (this.refs.read(`layers/${dstName}`)) {
      throw new RepositoryError('exists', `layer ${dstName} already exists`)
    }
    const src = this.seal(srcName)
    const record: LayerRecord = {
      ...src.record,
      v: 1,
      id: randomUUID(),
      name: dstName,
      status: 'active',
      savedRoot: src.record.savedRoot,
      parent: null,
      createdAt: new Date().toISOString(),
      agent: src.record.agent,
      chunks: src.record.chunks,
      subtasks: src.record.subtasks,
      endedAt: null,
      publishedAs: null,
    }
    this.refs.init(`layers/${dstName}`, record)
    this.materializeWorkspace(dstName, Oid.parse(src.record.savedRoot ?? src.record.baseTree))
    this.timeline.append('layer.cloned', { source: srcName, layer: dstName })
    return record
  }

  layerDelete(name: string): void {
    const record = this.layer(name)
    if (record.status === 'published') {
      throw new RepositoryError('published', `layer ${name} is published and retained as provenance`)
    }
    rmSync(this.refsPathForLayer(name), { force: true })
    rmSync(this.workspacePath(name), { recursive: true, force: true })
    rmSync(this.statIndexPath(name), { force: true })
    this.timeline.append('layer.deleted', { layer: name })
  }

  private refsPathForLayer(name: string): string {
    return join(this.metaDir, 'refs', 'layers', name)
  }

  // Seal captures the workspace into immutable objects and advances the
  // layer's saved root. It is the autosave boundary; the workspace folder
  // itself is the continuously present working state.
  seal(name: string): { record: LayerRecord; changes: Map<string, Change>; tree: Oid } {
    const entry = this.refs.read<LayerRecord>(`layers/${name}`)
    if (!entry) throw new RepositoryError('not-found', `layer ${name} does not exist`)
    const record = entry.data
    if (record.status === 'published') {
      throw new RepositoryError('published', `layer ${name} is already published`)
    }
    const trackedTree = Oid.parse(record.savedRoot ?? record.baseTree)
    const tracked = this.trees.listFiles(trackedTree)
    const workspace = this.workspacePath(name)
    const changes: Map<string, Change> = new Map()
    const index = this.loadStatIndex(name)
    if (existsSync(workspace)) {
      this.scanInto(workspace, '', tracked, IgnoreRules.load(this.projectDir), changes, index)
      this.saveStatIndex(name, index)
    }
    // Paths tracked but absent from the workspace were deleted.
    for (const path of tracked.keys()) {
      const present = pathPresent(join(workspace, path))
      const scanned = changes.get(path)
      if (!present && !scanned) changes.set(path, null)
    }
    if (changes.size === 0) {
      if (!record.savedRoot) {
        this.updateLayer(name, (d) => ({ ...d, savedRoot: trackedTree.ref }))
      }
      return { record: this.layer(name), changes, tree: trackedTree }
    }
    const tree = this.trees.applyChanges(Oid.parse(record.baseTree), changes)
    this.updateLayer(name, (d) => ({ ...d, savedRoot: tree.ref }))
    this.timeline.append('layer.sealed', { layer: name, changes: String(changes.size) })
    return { record: this.layer(name), changes, tree }
  }

  layerStatus(name: string): {
    record: LayerRecord
    unsealed: string[]
    missing: string[]
    worldAhead: boolean
  } {
    const record = this.layer(name)
    const workspace = this.workspacePath(name)
    const trackedTree = Oid.parse(record.savedRoot ?? record.baseTree)
    const tracked = this.trees.listFiles(trackedTree)
    const changes: Map<string, Change> = new Map()
    const index = this.loadStatIndex(name)
    if (existsSync(workspace)) {
      this.scanInto(workspace, '', tracked, IgnoreRules.load(this.projectDir), changes, index)
      this.saveStatIndex(name, index)
    }
    const missing = [...tracked.keys()].filter((p) => !pathPresent(join(workspace, p)))
    return {
      record,
      unsealed: [...changes.keys()].sort(),
      missing,
      worldAhead: this.worldRef().data.seq > record.baseSeq,
    }
  }

  // ---- publish ----

  publish(
    name: string,
    opts?: { note?: string; allowMissingContext?: boolean; operationId?: string },
  ): PublishResult | ConflictResult {
    const op = this.opsBegin(opts?.operationId)
    if (op.replayed) return op.result as PublishResult | ConflictResult
    try {
      const result = this.publishInner(name, opts)
      this.opsFinish(op.id, result)
      return result
    } catch (e) {
      this.recoverOrAbort(op.id, name)
      throw e
    }
  }

  // Whether publishing this layer would hit the missing-context gate, so a
  // caller can ask the user before starting the operation at all.
  requiresContextDecision(name: string): boolean {
    const record = this.layer(name)
    if (record.status === 'published' || !record.agent) return false
    return record.chunks.length === 0 && record.subtasks.every((s) => s.chunks.length === 0)
  }

  private publishInner(
    name: string,
    opts?: { note?: string; allowMissingContext?: boolean; operationId?: string },
  ): PublishResult | ConflictResult {
    const entry = this.refs.read<LayerRecord>(`layers/${name}`)
    if (!entry) throw new RepositoryError('not-found', `layer ${name} does not exist`)
    let record = entry.data
    if (record.status === 'published') {
      return {
        status: 'published',
        seq: this.worldRecord(record.publishedAs!).seq,
        version: record.publishedAs!,
        changedPaths: [],
      }
    }
    if (record.agent && record.chunks.length === 0 && record.subtasks.every((s) => s.chunks.length === 0)) {
      if (opts?.allowMissingContext !== true) {
        throw new RepositoryError('missing-context', `agent layer ${name} has no captured trace`, {
          layer: name,
        })
      }
      this.timeline.append('context.missing.override', { layer: name })
    }

    const sealed = this.seal(name)
    record = sealed.record

    for (let attempt = 0; attempt < LATEST_SCAN_LIMIT; attempt++) {
      // A crashed attempt may have accepted the version but died before
      // updating this layer; adopt that version instead of duplicating it.
      const adopted = this.findVersionByLayer(record.id, record.baseSeq)
      if (adopted) {
        this.updateLayer(name, (d) => ({ ...d, status: 'published', publishedAs: adopted.ref }))
        rmSync(this.workspacePath(name), { recursive: true, force: true })
        return {
          status: 'published',
          seq: this.worldRecord(adopted.ref).seq,
          version: adopted.ref,
          changedPaths: [],
        }
      }
      const world = this.worldRef()
      const current = this.worldRecord(world.data.head)
      const composed = compose(
        this.trees,
        Oid.parse(record.baseTree),
        Oid.parse(record.savedRoot!),
        Oid.parse(current.codeTree),
      )
      if (!composed.ok) {
        const result: ConflictResult = {
          status: 'conflict',
          target: name,
          sources: [name],
          conflicts: composed.conflicts,
        }
        this.timeline.append('publish.rejected', {
          layer: name,
          conflicts: String(composed.conflicts.length),
        })
        return result
      }
      const contextRoot = this.buildContextRoot(record)
      const worldRecord: WorldVersionRecord = {
        v: 1,
        seq: world.data.seq + 1,
        parent: world.data.head,
        codeTree: composed.tree.ref,
        contextRoot: contextRoot?.ref ?? null,
        layerId: record.id,
        layerName: name,
        publishedAt: new Date().toISOString(),
        ...(opts?.note ? { note: opts.note } : {}),
        ...(opts?.allowMissingContext && record.agent ? { missingContextOverride: true } : {}),
      }
      const { id } = this.putWorldRecord(worldRecord)
      try {
        this.refs.casWrite('world', world.gen, { v: 1, seq: worldRecord.seq, head: id.ref }, { fsyncDir: true })
      } catch (e) {
        if (e instanceof CasConflict) continue
        throw e
      }
      this.updateLayer(name, (d) => ({
        ...d,
        status: 'published',
        publishedAs: id.ref,
      }))
      rmSync(this.workspacePath(name), { recursive: true, force: true })
      this.timeline.append('layer.published', { layer: name, version: id.ref, seq: String(worldRecord.seq) })
      this.timeline.append('world.version.created', { version: id.ref, seq: String(worldRecord.seq) })
      return { status: 'published', seq: worldRecord.seq, version: id.ref, changedPaths: composed.changedPaths }
    }
    throw new RepositoryError('contended', `publish of ${name} lost the race ${LATEST_SCAN_LIMIT} times`)
  }

  private findVersionByLayer(layerId: string, baseSeq: number): { ref: string } | null {
    let ref: string | null = this.worldRef().data.head
    while (ref) {
      const record = this.worldRecord(ref)
      if (record.layerId === layerId) return { ref }
      if (record.seq <= baseSeq) return null
      ref = record.parent
    }
    return null
  }

  private buildContextRoot(record: LayerRecord): Oid | null {
    if (!record.agent) return null
    if (record.chunks.length === 0 && record.subtasks.length === 0) return null
    return this.putContext({
      v: 1,
      agentType: record.agent.type,
      sessionId: record.agent.sessionId,
      chunks: record.chunks,
      subtasks: record.subtasks,
    } as unknown as CborValue)
  }

  // ---- stack ----

  stack(sources: string[], into: string, opts?: { operationId?: string }): StackResult | ConflictResult {
    const op = this.opsBegin(opts?.operationId)
    if (op.replayed) return op.result as StackResult | ConflictResult
    try {
      const result = this.stackInner(sources, into)
      this.opsFinish(op.id, result)
      return result
    } catch (e) {
      // Stack mutates only after every source composes cleanly, so an
      // exception means nothing was written: release the operation.
      this.opsAbort(op.id)
      throw e
    }
  }

  private stackInner(sources: string[], into: string): StackResult | ConflictResult {
    const targetEntry = this.refs.read<LayerRecord>(`layers/${into}`)
    if (!targetEntry) throw new RepositoryError('not-found', `layer ${into} does not exist`)
    if (targetEntry.data.status === 'published') {
      throw new RepositoryError('published', `layer ${into} is published`)
    }
    if (sources.includes(into)) {
      throw new RepositoryError('usage', 'a layer cannot stack into itself')
    }
    for (const name of sources) {
      const record = this.layer(name)
      if (record.status === 'published') {
        throw new RepositoryError('published', `layer ${name} is published`)
      }
    }
    const ordered = this.orderForStack(sources)
    for (const name of [...sources, into]) this.seal(name)

    let curTree = this.layer(into).savedRoot ?? this.layer(into).baseTree
    const merged: string[] = []
    for (const name of ordered) {
      const src = this.layer(name)
      const composed = compose(
        this.trees,
        Oid.parse(src.baseTree),
        Oid.parse(src.savedRoot ?? src.baseTree),
        Oid.parse(curTree),
      )
      if (!composed.ok) {
        const result: ConflictResult = {
          status: 'conflict',
          target: into,
          sources: [...sources],
          conflicts: composed.conflicts,
        }
        this.timeline.append('publish.rejected', {
          layer: into,
          conflicts: String(composed.conflicts.length),
        })
        return result
      }
      curTree = composed.tree.ref
      merged.push(...composed.changedPaths)
    }
    this.updateLayer(into, (d) => ({ ...d, savedRoot: curTree }))
    this.materializeWorkspace(into, Oid.parse(curTree))
    this.timeline.append('layers.stacked', {
      layer: into,
      sources: sources.join(','),
      changes: String(new Set(merged).size),
    })
    return { status: 'stacked', target: into, sources: [...sources], changedPaths: [...new Set(merged)].sort() }
  }

  // Declared ancestry is applied ancestor-first; independent sources keep
  // their written order.
  private orderForStack(sources: string[]): string[] {
    const records = new Map(sources.map((name) => [name, this.layer(name)]))
    const out: string[] = []
    const remaining = new Set(sources)
    let guard = sources.length + 1
    while (remaining.size > 0) {
      if (guard-- === 0) throw new RepositoryError('usage', 'layer ancestry among stack sources is cyclic')
      let progressed = false
      for (const name of [...remaining]) {
        const parent = records.get(name)!.parent
        if (!parent || !remaining.has(parent)) {
          out.push(name)
          remaining.delete(name)
          progressed = true
        }
      }
      if (!progressed) throw new RepositoryError('usage', 'layer ancestry among stack sources is cyclic')
    }
    return out
  }

  // ---- sessions and context ----

  sessionStart(layerName: string, agent: { type: string; sessionId: string }): LayerRecord {
    const record = this.layer(layerName)
    if (record.status !== 'active') {
      throw new RepositoryError('usage', `layer ${layerName} is ${record.status}, not active`)
    }
    const updated = this.updateLayer(layerName, (d) => ({ ...d, agent }))
    this.timeline.append('agent.session.started', {
      layer: layerName,
      agent: agent.type,
      session: agent.sessionId,
    })
    return updated
  }

  sessionTrace(sessionId: string, tracePath: string, opts?: { allowSecrets?: boolean }): LayerRecord {
    const bytes = new Uint8Array(readFileSync(tracePath))
    const findings = scanTraceForSecrets(bytes)
    if (findings.length > 0 && opts?.allowSecrets !== true) {
      throw new RepositoryError(
        'trace-secrets',
        `${tracePath} looks like it contains credentials; pass --allow-secrets to store it anyway`,
        { findings },
      )
    }
    const { layerName } = this.findSession(sessionId)
    const chunk = this.store.put('trace-chunk', bytes)
    return this.updateLayer(layerName, (d) => ({ ...d, chunks: [...d.chunks, chunk.ref] }))
  }

  sessionSubtask(
    sessionId: string,
    subtask: { taskId: string; agentType: string; tracePath?: string; childLayer?: string; allowSecrets?: boolean },
  ): LayerRecord {
    const { layerName } = this.findSession(sessionId)
    let chunks: string[] = []
    if (subtask.tracePath) {
      const bytes = new Uint8Array(readFileSync(subtask.tracePath))
      const findings = scanTraceForSecrets(bytes)
      if (findings.length > 0 && subtask.allowSecrets !== true) {
        throw new RepositoryError(
          'trace-secrets',
          `${subtask.tracePath} looks like it contains credentials; pass --allow-secrets to store it anyway`,
          { findings },
        )
      }
      chunks = [this.store.put('trace-chunk', bytes).ref]
    }
    return this.updateLayer(layerName, (d) => ({
      ...d,
      subtasks: [
        ...d.subtasks,
        {
          taskId: subtask.taskId,
          agentType: subtask.agentType,
          chunks,
          ...(subtask.childLayer ? { childLayer: subtask.childLayer } : {}),
          startedAt: new Date().toISOString(),
        },
      ],
    }))
  }

  sessionEnd(sessionId: string, opts?: { tracePath?: string }): LayerRecord {
    const { layerName } = this.findSession(sessionId)
    if (opts?.tracePath) this.sessionTrace(sessionId, opts.tracePath)
    this.updateLayer(layerName, (d) => ({ ...d, endedAt: new Date().toISOString(), status: 'ready' }))
    this.seal(layerName)
    return this.layer(layerName)
  }

  private findSession(sessionId: string): { layerName: string; record: LayerRecord } {
    for (const name of this.layerNames()) {
      const record = this.layer(name)
      if (record.agent?.sessionId === sessionId) return { layerName: name, record }
    }
    throw new RepositoryError('not-found', `no active session ${sessionId}`)
  }

  // ---- diff, show, verify ----

  diffLayer(name: string): {
    sealed: Array<{ path: string; before: TreeEntry | null; after: TreeEntry | null }>
    unsealed: string[]
  } {
    const record = this.layer(name)
    const sealed = this.trees.diffPaths(
      Oid.parse(record.baseTree),
      Oid.parse(record.savedRoot ?? record.baseTree),
    )
    const status = this.layerStatus(name)
    return { sealed, unsealed: [...status.unsealed, ...status.missing] }
  }

  diffWorlds(fromSeq: number, toSeq: number) {
    const chain = this.history()
    const from = chain.find((r) => r.seq === fromSeq)
    const to = chain.find((r) => r.seq === toSeq)
    if (!from || !to) throw new RepositoryError('not-found', 'world version not found')
    return this.trees.diffPaths(Oid.parse(from.codeTree), Oid.parse(to.codeTree))
  }

  verify(mode: 'quick' | 'full'): { ok: boolean; problems: string[] } {
    const problems: string[] = []
    try {
      const head = this.worldRef().data
      let ref: string | null = head.head
      while (ref) {
        try {
          const record = this.worldRecord(ref)
          if (mode === 'full') this.verifyTree(Oid.parse(record.codeTree), problems)
          if (record.contextRoot && mode === 'full') this.verifyContext(record.contextRoot, problems)
          ref = record.parent
        } catch (e) {
          problems.push(`world version ${ref}: ${(e as Error).message}`)
          break
        }
      }
      for (const name of this.layerNames()) {
        try {
          const record = this.layer(name)
          if (record.savedRoot && mode === 'full') this.verifyTree(Oid.parse(record.savedRoot), problems)
        } catch (e) {
          problems.push(`layer ${name}: ${(e as Error).message}`)
        }
      }
      this.timeline.read()
    } catch (e) {
      problems.push((e as Error).message)
    }
    return { ok: problems.length === 0, problems }
  }

  private verifyTree(treeId: Oid, problems: string[]): void {
    try {
      const { leaves, dirs } = this.trees.readTree(treeId)
      for (const leaf of leaves) {
        if (!this.store.verify(leaf.kind === 'symlink' ? 'symlink' : 'file', leaf.oid)) {
          problems.push(`blob ${leaf.oid.ref} for ${leaf.name} fails verification`)
        }
      }
      for (const dir of dirs) this.verifyTree(dir.oid, problems)
    } catch (e) {
      problems.push(`tree ${treeId.ref}: ${(e as Error).message}`)
    }
  }

  private verifyContext(ref: string, problems: string[]): void {
    try {
      const { record } = this.store.getRecord('context-root', Oid.parse(ref))
      const ctx = record as unknown as { chunks: string[]; subtasks: Array<{ chunks: string[] }> }
      for (const chunk of ctx.chunks ?? []) {
        if (!this.store.verify('trace-chunk', Oid.parse(chunk))) {
          problems.push(`trace chunk ${chunk} fails verification`)
        }
      }
      for (const sub of ctx.subtasks ?? []) {
        for (const chunk of sub.chunks ?? []) {
          if (!this.store.verify('trace-chunk', Oid.parse(chunk))) {
            problems.push(`trace chunk ${chunk} fails verification`)
          }
        }
      }
    } catch (e) {
      problems.push(`context root ${ref}: ${(e as Error).message}`)
    }
  }

  // ---- scanning and workspace materialization ----

  private scanTree(
    dir: string,
    tracked: Map<string, TreeEntry> | null,
    ignore: IgnoreRules,
  ): Map<string, Change> {
    const changes: Map<string, Change> = new Map()
    this.scanInto(dir, '', tracked ?? new Map(), ignore, changes)
    return changes
  }

  // Walks a workspace directory and fills `changes` with everything that
  // differs from the tracked state. Untracked paths matching ignore rules
  // are skipped; tracked paths are never dropped by rules.
  //
  // The stat index maps each scanned path to the mtime, size, inode, and
  // content id seen at the last scan. A file whose signature is unchanged
  // reuses the recorded id without reading or hashing bytes, so seal and
  // status cost follows edited files, not the size of the World.
  private scanInto(
    dir: string,
    prefix: string,
    tracked: Map<string, TreeEntry>,
    ignore: IgnoreRules,
    changes: Map<string, Change>,
    index?: { read: Map<string, StatIndexEntry>; write: Map<string, StatIndexEntry> },
  ): void {
    const trackedDirs = new Set<string>()
    for (const path of tracked.keys()) {
      let seg = path.indexOf('/')
      while (seg !== -1) {
        trackedDirs.add(path.slice(0, seg))
        seg = path.indexOf('/', seg + 1)
      }
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name
      if (entry.name === '.javelin') continue
      if (entry.isDirectory()) {
        if (!trackedDirs.has(path) && ignore.matched(path, true)) continue
        this.scanInto(join(dir, entry.name), `${path}/`, tracked, ignore, changes, index)
        continue
      }
      validatePath(path)
      const known = tracked.get(path) ?? null
      if (!known && ignore.matched(path, false)) continue
      if (entry.isSymbolicLink()) {
        const oid = this.trees.putSymlink(readlinkSync(join(dir, entry.name)))
        if (!known || known.kind !== 'symlink' || !known.oid.equals(oid)) {
          changes.set(path, { kind: 'symlink', oid })
        }
        continue
      }
      if (!entry.isFile()) continue
      const full = join(dir, entry.name)
      const st = statSync(full)
      const cached = index?.read.get(path)
      let kind: FileKind
      let oid: Oid
      if (cached && cached.m === st.mtimeMs && cached.s === st.size && cached.i === st.ino) {
        kind = cached.kind
        oid = Oid.parse(cached.oid)
        index?.write.set(path, cached)
      } else {
        kind = (st.mode & 0o111) !== 0 ? 'exec' : 'file'
        oid = this.trees.putBlob(new Uint8Array(readFileSync(full)))
        index?.write.set(path, { m: st.mtimeMs, s: st.size, i: st.ino, kind, oid: oid.ref })
      }
      if (!known || known.kind !== kind || !known.oid.equals(oid)) {
        changes.set(path, { kind, oid })
      }
    }
  }

  private statIndexPath(name: string): string {
    return join(this.metaDir, 'workspaces', `${name}.index`)
  }

  private loadStatIndex(name: string): {
    read: Map<string, StatIndexEntry>
    write: Map<string, StatIndexEntry>
  } {
    const path = this.statIndexPath(name)
    const read = new Map<string, StatIndexEntry>()
    if (existsSync(path)) {
      try {
        const body = JSON.parse(readFileSync(path, 'utf8')) as Record<string, StatIndexEntry>
        for (const [k, v] of Object.entries(body)) read.set(k, v)
      } catch {
        // a torn index is a cache miss, never an error
      }
    }
    return { read, write: new Map() }
  }

  private saveStatIndex(name: string, index: { write: Map<string, StatIndexEntry> }): void {
    const path = this.statIndexPath(name)
    const body: Record<string, StatIndexEntry> = {}
    for (const [k, v] of index.write) body[k] = v
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(body))
    renameSync(tmp, path)
  }

  // Workspaces materialize from a template cache. The first materialization
  // of a given tree writes every file once and keeps the result under
  // .javelin/cache/trees; every later materialization of that tree is a
  // copy-on-write clone of the template, so per-layer cost drops from a full
  // copy to near zero. Templates are replaceable cache, not canonical state.
  private materializeWorkspace(name: string, treeId: Oid): void {
    const dest = this.workspacePath(name)
    rmSync(dest, { recursive: true, force: true })
    const template = this.templatePath(treeId)
    if (existsSync(template)) {
      copyTree(template, dest)
      return
    }
    const staging = `${dest}.staging-${process.pid}-${Date.now()}`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    for (const [path, entry] of this.trees.listFiles(treeId)) {
      validatePath(path)
      const target = join(staging, path)
      mkdirSync(dirname(target), { recursive: true })
      if (entry.kind === 'symlink') {
        symlinkSync(this.trees.readSymlink(entry.oid), target)
        continue
      }
      writeFileSync(target, this.trees.readBlob(entry.oid))
      if (entry.kind === 'exec') chmodSync(target, 0o755)
    }
    mkdirSync(dirname(template), { recursive: true })
    const templateTmp = `${template}.tmp-${process.pid}-${Date.now()}`
    copyTree(staging, templateTmp)
    renameSync(templateTmp, template)
    rmSync(staging, { recursive: true, force: true })
    copyTree(template, dest)
    this.pruneTemplates(treeId)
  }

  private templatePath(treeId: Oid): string {
    return join(this.metaDir, 'cache', 'trees', treeId.hex)
  }

  // Keep a handful of recent templates; older ones are rebuildable on demand.
  private pruneTemplates(keep: Oid): void {
    const dir = join(this.metaDir, 'cache', 'trees')
    if (!existsSync(dir)) return
    const entries = readdirSync(dir)
      .filter((n) => n !== keep.hex && !n.includes('.tmp-'))
      .map((n) => ({ n, at: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const entry of entries.slice(TEMPLATE_CACHE_SIZE)) {
      rmSync(join(dir, entry.n), { recursive: true, force: true })
    }
  }

  // Rebuild a layer's workspace folder when it is missing (crash during a
  // materialization swap, manual deletion). The durable state is untouched.
  ensureWorkspace(name: string): string {
    const record = this.layer(name)
    if (record.status === 'published') {
      throw new RepositoryError('published', `layer ${name} is published and read-only`)
    }
    const dest = this.workspacePath(name)
    if (!existsSync(dest)) {
      this.materializeWorkspace(name, Oid.parse(record.savedRoot ?? record.baseTree))
    }
    return dest
  }

  // ---- garbage collection ----

  // Removes objects that no reachable root references and that are older
  // than the grace window, so an in-flight write is never reclaimed. Purely
  // a reclamation pass: correctness never depends on it running.
  gc(opts?: { graceMs?: number }): { removed: number; bytes: number; live: number } {
    const graceMs = opts?.graceMs ?? 60 * 60 * 1000
    const live = new Set<string>()
    let ref: string | null = this.worldRef().data.head
    while (ref) {
      const record = this.worldRecord(ref)
      live.add(ref.slice('blake3:'.length))
      this.markTree(record.codeTree, live)
      if (record.contextRoot) this.markContext(record.contextRoot, live)
      ref = record.parent
    }
    for (const name of this.layerNames()) {
      const record = this.layer(name)
      if (record.publishedAs) {
        live.add(record.publishedAs.slice('blake3:'.length))
        const published = this.worldRecord(record.publishedAs)
        this.markTree(published.codeTree, live)
        if (published.contextRoot) this.markContext(published.contextRoot, live)
      }
      const root = record.savedRoot ?? record.baseTree
      this.markTree(root, live)
      for (const chunk of record.chunks) live.add(chunk.slice('blake3:'.length))
      for (const sub of record.subtasks) {
        for (const chunk of sub.chunks) live.add(chunk.slice('blake3:'.length))
      }
    }
    const objectsDir = join(this.metaDir, 'objects')
    const cutoff = Date.now() - graceMs
    let removed = 0
    let bytes = 0
    if (existsSync(objectsDir)) {
      for (const shard of readdirSync(objectsDir)) {
        const shardDir = join(objectsDir, shard)
        for (const rest of readdirSync(shardDir)) {
          const file = join(shardDir, rest)
          const hex = shard + rest
          if (live.has(hex)) continue
          const st = statSync(file)
          if (st.mtimeMs > cutoff) continue
          bytes += st.size
          rmSync(file, { force: true })
          removed++
        }
      }
      for (const shard of readdirSync(objectsDir)) {
        const shardDir = join(objectsDir, shard)
        try {
          if (readdirSync(shardDir).length === 0) rmdirSync(shardDir)
        } catch {
          // a concurrent writer recreated it; harmless
        }
      }
    }
    return { removed, bytes, live: live.size }
  }

  private markTree(ref: string, live: Set<string>): void {
    const stack = [Oid.parse(ref)]
    while (stack.length > 0) {
      const treeId = stack.pop()!
      const hex = treeId.hex
      if (live.has(hex)) continue
      live.add(hex)
      const { leaves, dirs } = this.trees.readTree(treeId)
      for (const leaf of leaves) live.add(leaf.oid.hex)
      for (const dir of dirs) stack.push(dir.oid)
    }
  }

  private markContext(ref: string, live: Set<string>): void {
    live.add(ref.slice('blake3:'.length))
    const { record } = this.store.getRecord('context-root', Oid.parse(ref))
    const ctx = record as unknown as { chunks: string[]; subtasks: Array<{ chunks: string[] }> }
    for (const chunk of ctx.chunks ?? []) live.add(chunk.slice('blake3:'.length))
    for (const sub of ctx.subtasks ?? []) {
      for (const chunk of sub.chunks ?? []) live.add(chunk.slice('blake3:'.length))
    }
  }

  // ---- diagnostics and repair ----

  // Checks the repository's structure and repairs what is safe to repair:
  // a missing workspace is rematerialized from the sealed state, leftover
  // staging and temp files from crashed runs are removed. It never touches
  // canonical objects.
  doctor(): { fixed: string[]; problems: string[] } {
    const fixed: string[] = []
    const problems: string[] = []
    try {
      let ref: string | null = this.worldRef().data.head
      let guard = 1_000_000
      while (ref && guard-- > 0) {
        const record = this.worldRecord(ref)
        ref = record.parent
      }
      if (guard <= 0) problems.push('world version chain does not terminate')
    } catch (e) {
      problems.push(`world chain: ${(e as Error).message}`)
    }
    for (const name of this.layerNames()) {
      const record = this.layer(name)
      if (record.status === 'published') continue
      const dest = this.workspacePath(name)
      if (!existsSync(dest)) {
        try {
          this.materializeWorkspace(name, Oid.parse(record.savedRoot ?? record.baseTree))
          fixed.push(`rematerialized workspace for ${name}`)
        } catch (e) {
          problems.push(`workspace ${name}: ${(e as Error).message}`)
        }
      }
    }
    const workspaces = join(this.metaDir, 'workspaces')
    if (existsSync(workspaces)) {
      for (const entry of readdirSync(workspaces)) {
        if (entry.includes('.staging-') || entry.includes('.tmp-')) {
          rmSync(join(workspaces, entry), { recursive: true, force: true })
          fixed.push(`removed leftover ${entry}`)
        }
      }
    }
    const layersDir = join(this.metaDir, 'refs', 'layers')
    if (existsSync(layersDir)) {
      for (const entry of readdirSync(layersDir)) {
        if (entry.includes('.tmp-')) {
          rmSync(join(layersDir, entry), { force: true })
          fixed.push(`removed stale ref ${entry}`)
        }
      }
    }
    try {
      this.timeline.read()
    } catch (e) {
      problems.push(`timeline: ${(e as Error).message}`)
    }
    const report = this.verify('quick')
    problems.push(...report.problems)
    return { fixed, problems }
  }

  // ---- idempotent operations ----

  private opsPath(operationId: string): string {
    return join(this.metaDir, 'ops', `${operationId}.json`)
  }

  // An operation file records the holder's pid. A file left running by a
  // dead process is adopted; a live holder blocks the id until it finishes.
  private opsBegin(operationId?: string): { id: string | null; replayed: boolean; result?: unknown } {
    if (!operationId) return { id: null, replayed: false }
    const path = this.opsPath(operationId)
    if (existsSync(path)) {
      let body: { status?: string; result?: unknown; pid?: number; at?: string }
      try {
        body = JSON.parse(readFileSync(path, 'utf8')) as typeof body
      } catch {
        body = {}
      }
      if (body.status === 'done') return { id: operationId, replayed: true, result: body.result }
      const startedAt = body.at ? Date.parse(body.at) : 0
      const stale = Date.now() - startedAt > OP_STALE_MS
      const alive = body.pid !== undefined && pidAlive(body.pid)
      if (alive && !stale && body.status === 'running') {
        throw new RepositoryError('operation-in-progress', `operation ${operationId} is already running`)
      }
    }
    mkdirSync(join(this.metaDir, 'ops'), { recursive: true })
    this.writeOpsFile(operationId, { status: 'running', pid: process.pid, at: new Date().toISOString() })
    return { id: operationId, replayed: false }
  }

  private writeOpsFile(operationId: string, body: Record<string, unknown>): void {
    const path = this.opsPath(operationId)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(body))
    renameSync(tmp, path)
  }

  // Called when the wrapped operation throws: adopt an accepted version if
  // the mutation landed before the failure, otherwise release the id.
  private recoverOrAbort(operationId: string | null, layerName: string): void {
    if (!operationId) return
    try {
      const record = this.layer(layerName)
      const adopted = record.status === 'published' ? null : this.findVersionByLayer(record.id, record.baseSeq)
      const version = record.publishedAs ?? adopted?.ref ?? null
      if (version) {
        this.opsFinish(operationId, {
          status: 'published',
          seq: this.worldRecord(version).seq,
          version,
          changedPaths: [],
        })
        return
      }
    } catch {
      // fall through and release the id
    }
    this.opsAbort(operationId)
  }

  private opsAbort(operationId: string | null): void {
    if (!operationId) return
    rmSync(this.opsPath(operationId), { force: true })
  }

  private opsFinish(operationId: string | null, result: unknown): void {
    if (!operationId) return
    this.writeOpsFile(operationId, { status: 'done', result })
  }
}

function validateLayerName(name: string): void {
  if (name === '' || name.includes('/') || name.startsWith('.')) {
    throw new RepositoryError('usage', `invalid layer name ${JSON.stringify(name)}`)
  }
  assertNoCollisions([name])
}
