import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, rmSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs'
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
import { validatePath, assertNoCollisions } from './paths.ts'

export type Change = { kind: FileKind; oid: Oid } | null

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
    return readdirSync(dir).sort()
  }

  layer(name: string): LayerRecord {
    const entry = this.refs.read<LayerRecord>(`layers/${name}`)
    if (!entry) throw new RepositoryError('not-found', `layer ${name} does not exist`)
    return entry.data
  }

  private writeLayer(name: string, record: LayerRecord, expectedGen: number): void {
    this.refs.casWrite(`layers/${name}`, expectedGen, record)
  }

  private updateLayer(name: string, mutate: (record: LayerRecord) => LayerRecord): LayerRecord {
    const entry = this.refs.update<LayerRecord>(`layers/${name}`, (d) => {
      if (!d) throw new RepositoryError('not-found', `layer ${name} does not exist`)
      return mutate(d)
    })
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
    if (existsSync(workspace)) {
      this.scanInto(workspace, '', tracked, IgnoreRules.load(this.projectDir), changes)
    }
    // Paths tracked but absent from the workspace were deleted.
    for (const path of tracked.keys()) {
      const present = existsSync(join(workspace, path))
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
    if (existsSync(workspace)) {
      this.scanInto(workspace, '', tracked, IgnoreRules.load(this.projectDir), changes)
    }
    const missing = [...tracked.keys()].filter((p) => !existsSync(join(workspace, p)))
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
    const result = this.publishInner(name, opts)
    this.opsFinish(op.id, result)
    return result
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
    const result = this.stackInner(sources, into)
    this.opsFinish(op.id, result)
    return result
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

  sessionTrace(sessionId: string, tracePath: string): LayerRecord {
    const { layerName, record } = this.findSession(sessionId)
    const chunk = this.store.put('trace-chunk', new Uint8Array(readFileSync(tracePath)))
    const updated = this.updateLayer(layerName, (d) => ({ ...d, chunks: [...d.chunks, chunk.ref] }))
    void record
    return updated
  }

  sessionSubtask(sessionId: string, subtask: { taskId: string; agentType: string; tracePath?: string; childLayer?: string }): LayerRecord {
    const { layerName } = this.findSession(sessionId)
    const chunks = subtask.tracePath
      ? [this.store.put('trace-chunk', new Uint8Array(readFileSync(subtask.tracePath))).ref]
      : []
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
  private scanInto(
    dir: string,
    prefix: string,
    tracked: Map<string, TreeEntry>,
    ignore: IgnoreRules,
    changes: Map<string, Change>,
  ): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name
      if (entry.name === '.javelin') continue
      if (entry.isDirectory()) {
        this.scanInto(join(dir, entry.name), `${path}/`, tracked, ignore, changes)
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
      const bytes = new Uint8Array(readFileSync(join(dir, entry.name)))
      const kind: FileKind = (statSync(join(dir, entry.name)).mode & 0o111) !== 0 ? 'exec' : 'file'
      const oid = this.trees.putBlob(bytes)
      if (!known || known.kind !== kind || !known.oid.equals(oid)) {
        changes.set(path, { kind, oid })
      }
    }
  }

  private materializeWorkspace(name: string, treeId: Oid): void {
    const dest = this.workspacePath(name)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    for (const [path, entry] of this.trees.listFiles(treeId)) {
      validatePath(path)
      const target = join(dest, path)
      mkdirSync(dirname(target), { recursive: true })
      if (entry.kind === 'symlink') {
        symlinkSync(this.trees.readSymlink(entry.oid), target)
        continue
      }
      writeFileSync(target, this.trees.readBlob(entry.oid))
      if (entry.kind === 'exec') chmodSync(target, 0o755)
    }
  }

  // ---- idempotent operations ----

  private opsBegin(operationId?: string): { id: string | null; replayed: boolean; result?: unknown } {
    if (!operationId) return { id: null, replayed: false }
    const path = join(this.metaDir, 'ops', `${operationId}.json`)
    if (existsSync(path)) {
      const body = JSON.parse(readFileSync(path, 'utf8')) as { status: string; result?: unknown }
      if (body.status === 'done') return { id: operationId, replayed: true, result: body.result }
      throw new RepositoryError('operation-in-progress', `operation ${operationId} is already running`)
    }
    mkdirSync(join(this.metaDir, 'ops'), { recursive: true })
    writeFileSync(path, JSON.stringify({ status: 'running', at: new Date().toISOString() }))
    return { id: operationId, replayed: false }
  }

  private opsFinish(operationId: string | null, result: unknown): void {
    if (!operationId) return
    const path = join(this.metaDir, 'ops', `${operationId}.json`)
    writeFileSync(path, JSON.stringify({ status: 'done', result }, null, 2))
  }
}

function validateLayerName(name: string): void {
  if (name === '' || name.includes('/') || name.startsWith('.')) {
    throw new RepositoryError('usage', `invalid layer name ${JSON.stringify(name)}`)
  }
  assertNoCollisions([name])
}

export function shortId(ref: string): string {
  return ref.slice(-12)
}

export { typedHash, Oid }
