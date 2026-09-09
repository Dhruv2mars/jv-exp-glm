import { Repo, RepositoryError } from '../core/repo.ts'
import type { PublishResult, ConflictResult, StackResult, LayerRecord } from '../core/repo.ts'
import { Oid } from '../core/oids.ts'

function worldTreeOf(repo: Repo, versionRef: string) {
  return Oid.parse(repo.worldRecord(versionRef).codeTree)
}

export interface JsonEnvelope {
  javelin: 1
  command: string
  ok: boolean
  data?: unknown
  error?: { code: string; message: string; retryable: boolean; [key: string]: unknown }
}

export interface Io {
  stdout: (line: string) => void
  stderr: (line: string) => void
  promptYesNo: (question: string) => Promise<boolean>
}

interface Args {
  positionals: string[]
  flags: Map<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--json') {
      flags.set('json', true)
      continue
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(body, next)
        i++
      } else {
        flags.set(body, true)
      }
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags }
}

function str(args: Args, name: string): string | undefined {
  const v = args.flags.get(name)
  return typeof v === 'string' ? v : undefined
}

function bool(args: Args, name: string): boolean {
  const v = args.flags.get(name)
  return v === true || typeof v === 'string'
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const USAGE = `javelin - an agent-native version control system

  javelin init [dir] [--note n]
  javelin layer create <name> [--parent <layer>] [--agent <type> --session <id>]
  javelin layer clone <src> <dst>
  javelin layer list
  javelin layer status [name]
  javelin layer open <name>
  javelin layer delete <name>
  javelin diff <layer>
  javelin diff --world <from> <to>
  javelin stack <layer...> --into <layer> [--operation-id id]
  javelin publish <layer> [--note n] [--allow-missing-context] [--operation-id id]
  javelin history [--limit n]
  javelin timeline [--limit n]
  javelin show world <seq>
  javelin show layer <name>
  javelin show event <id>
  javelin verify [--full]
  javelin session start --layer <layer> --agent <type> --session <id>
  javelin session trace --session <id> --file <path>
  javelin session subagent --session <id> --task <id> --agent <type> [--file <path>] [--child-layer <name>]
  javelin session end --session <id> [--file <path>]

Every command accepts --json for versioned machine output.
`

export async function run(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv)
  const json = bool(args, 'json')
  const [command] = args.positionals
  const hasSub = command === 'layer' || command === 'session' || command === 'show'
  const sub = hasSub ? args.positionals[1] : undefined
  const rest = hasSub ? args.positionals.slice(2) : args.positionals.slice(1)
  const commandName = [command, sub].filter(Boolean).join(' ')

  const emit = (ok: boolean, data: unknown): number => {
    if (json) {
      const envelope: JsonEnvelope = ok
        ? { javelin: 1, command: commandName, ok, data }
        : { javelin: 1, command: commandName, ok, error: data as NonNullable<JsonEnvelope['error']> }
      io.stdout(JSON.stringify(envelope, null, 2))
    } else {
      renderHuman(io, commandName, ok, data)
    }
    return ok ? 0 : 1
  }

  const fail = (code: string, message: string, retryable: boolean, details?: Record<string, unknown>): number =>
    emit(false, { code, message, retryable, ...(details ?? {}) })

  const needRepo = async (): Promise<Repo> => Repo.open(process.cwd())

  try {
    switch (command) {
      case 'help':
        io.stdout(USAGE)
        return 0
      case 'init': {
        const dir = rest[0] ?? '.'
        const note = str(args, 'note')
        const repo = await Repo.init(dir, { ...(note ? { note } : {}) })
        return emit(true, { version: repo.worldRef().data.head, seq: 1 })
      }
      case 'layer':
        return await layerCommands(args, sub, rest, needRepo, emit, fail)
      case 'diff':
        return await diffCommand(args, rest, needRepo, emit, fail)
      case 'stack':
        return await stackCommand(args, rest, needRepo, emit, fail)
      case 'publish':
        return await publishCommand(args, rest, io, needRepo, emit, fail)
      case 'history': {
        const repo = await needRepo()
        const limit = num(str(args, 'limit'))
        return emit(true, {
          head: repo.worldRef().data.seq,
          versions: repo.historyEntries(limit).map(({ id, record }) => ({
            seq: record.seq,
            version: id,
            layer: record.layerName,
            at: record.publishedAt,
            note: record.note ?? null,
            context: record.contextRoot,
          })),
        })
      }
      case 'timeline': {
        const repo = await needRepo()
        const limit = num(str(args, 'limit'))
        return emit(true, { events: repo.timeline.read(limit) })
      }
      case 'show':
        return await showCommand(sub, rest, needRepo, emit, fail)
      case 'verify': {
        const repo = await needRepo()
        const report = repo.verify(bool(args, 'full') ? 'full' : 'quick')
        return emit(report.ok, { ok: report.ok, problems: report.problems })
      }
      case 'session':
        return await sessionCommands(args, sub, needRepo, emit, fail)
      case undefined:
        return fail('usage', 'a command is required; try javelin help', false)
      default:
        return fail('usage', `unknown command ${command}`, false)
    }
  } catch (e) {
    if (e instanceof RepositoryError) {
      return fail(e.code, e.message, e.code === 'contended' || e.code === 'operation-in-progress', e.details)
    }
    return fail('error', (e as Error).message, false)
  }
}

type Emit = (ok: boolean, data: unknown) => number
type Fail = (code: string, message: string, retryable: boolean, details?: Record<string, unknown>) => number
type NeedRepo = () => Promise<Repo>

function conflictError(result: ConflictResult, verb: string): Record<string, unknown> {
  return {
    code: 'conflict',
    message: `${verb} rejected: ${result.conflicts.length} structural conflict${result.conflicts.length === 1 ? '' : 's'}`,
    retryable: false,
    target: result.target,
    sources: result.sources,
    conflicts: result.conflicts,
  }
}

async function layerCommands(args: Args, sub: string | undefined, rest: string[], needRepo: NeedRepo, emit: Emit, fail: Fail): Promise<number> {
  switch (sub) {
    case 'create': {
      const name = rest[0]
      if (!name) return fail('usage', 'usage: javelin layer create <name>', false)
      const repo = await needRepo()
      const agentType = str(args, 'agent')
      const sessionId = str(args, 'session')
      const record = await repo.layerCreate(name, {
        ...(str(args, 'parent') !== undefined ? { parent: str(args, 'parent')! } : {}),
        ...(agentType && sessionId ? { agent: { type: agentType, sessionId } } : {}),
      })
      return emit(true, summarizeLayer(record, repo))
    }
    case 'clone': {
      const [src, dst] = rest
      if (!src || !dst) return fail('usage', 'usage: javelin layer clone <src> <dst>', false)
      const repo = await needRepo()
      return emit(true, summarizeLayer(repo.layerClone(src, dst), repo))
    }
    case 'list': {
      const repo = await needRepo()
      return emit(true, { layers: repo.layerNames().map((n) => summarizeLayer(repo.layer(n), repo)) })
    }
    case 'status': {
      const repo = await needRepo()
      const name = rest[0] ?? repo.layerNames()[0]
      if (!name) return emit(true, { layers: [] })
      const s = repo.layerStatus(name)
      return emit(true, {
        layer: summarizeLayer(s.record, repo),
        unsealed: s.unsealed,
        missing: s.missing,
        worldAhead: s.worldAhead,
      })
    }
    case 'open': {
      const name = rest[0]
      if (!name) return fail('usage', 'usage: javelin layer open <name>', false)
      const repo = await needRepo()
      const record = repo.layer(name)
      if (record.status === 'published') return fail('published', `layer ${name} is published and read-only`, false)
      return emit(true, { layer: name, path: repo.workspacePath(name) })
    }
    case 'delete': {
      const name = rest[0]
      if (!name) return fail('usage', 'usage: javelin layer delete <name>', false)
      const repo = await needRepo()
      repo.layerDelete(name)
      return emit(true, { deleted: name })
    }
    default:
      return fail('usage', 'usage: javelin layer <create|clone|list|status|open|delete>', false)
  }
}

function summarizeLayer(record: LayerRecord, repo: Repo) {
  return {
    name: record.name,
    status: record.status,
    baseSeq: record.baseSeq,
    parent: record.parent,
    agent: record.agent?.type ?? null,
    session: record.agent?.sessionId ?? null,
    saved: record.savedRoot !== null,
    workspace: record.status === 'published' ? null : repo.workspacePath(record.name),
  }
}

function kindChanges(changes: Array<{ path: string; before: { kind: string } | null; after: { kind: string } | null }>) {
  return changes.map((c) => ({ path: c.path, before: c.before?.kind ?? 'absent', after: c.after?.kind ?? 'absent' }))
}

async function diffCommand(args: Args, rest: string[], needRepo: NeedRepo, emit: Emit, fail: Fail): Promise<number> {
  const repo = await needRepo()
  if (bool(args, 'world')) {
    const [from, to] = [num(rest[0]), num(rest[1])]
    if (from === undefined || to === undefined) return fail('usage', 'usage: javelin diff --world <from> <to>', false)
    return emit(true, { from: `v${from}`, to: `v${to}`, changes: kindChanges(repo.diffWorlds(from, to)) })
  }
  const name = rest[0]
  if (!name) return fail('usage', 'usage: javelin diff <layer>', false)
  const { sealed, unsealed } = repo.diffLayer(name)
  return emit(true, { layer: name, sealed: kindChanges(sealed), unsealed })
}

async function stackCommand(args: Args, rest: string[], needRepo: NeedRepo, emit: Emit, fail: Fail): Promise<number> {
  const into = str(args, 'into')
  if (!into || rest.length === 0) return fail('usage', 'usage: javelin stack <layer...> --into <layer>', false)
  const repo = await needRepo()
  const operationId = str(args, 'operation-id')
  const result = repo.stack(rest, into, { ...(operationId ? { operationId } : {}) })
  if (result.status === 'conflict') return emit(false, conflictError(result, 'stack'))
  return emit(true, result)
}

async function publishCommand(args: Args, rest: string[], io: Io, needRepo: NeedRepo, emit: Emit, fail: Fail): Promise<number> {
  const name = rest[0]
  if (!name) return fail('usage', 'usage: javelin publish <layer>', false)
  const repo = await needRepo()
  const operationId = str(args, 'operation-id')
  const note = str(args, 'note')
  const doPublish = (allowMissingContext: boolean) =>
    repo.publish(name, {
      ...(note ? { note } : {}),
      ...(allowMissingContext ? { allowMissingContext: true } : {}),
      ...(operationId ? { operationId } : {}),
    })

  try {
    const result = doPublish(bool(args, 'allow-missing-context'))
    if (result.status === 'conflict') return emit(false, conflictError(result, 'publish'))
    return emit(true, result)
  } catch (e) {
    if (e instanceof RepositoryError && e.code === 'missing-context' && process.stdin.isTTY) {
      const answer = await io.promptYesNo('Agent context is unavailable for this layer. Publish without context? [y/N] ')
      if (!answer) return fail('missing-context', 'publish cancelled by user', true, e.details)
      const result = doPublish(true)
      if (result.status === 'conflict') return emit(false, conflictError(result, 'publish'))
      return emit(true, result)
    }
    throw e
  }
}

async function sessionCommands(args: Args, sub: string | undefined, needRepo: NeedRepo, emit: Emit, fail: Fail): Promise<number> {
  const repo = await needRepo()
  switch (sub) {
    case 'start': {
      const layer = str(args, 'layer')
      const agent = str(args, 'agent')
      const session = str(args, 'session')
      if (!layer || !agent || !session) return fail('usage', 'usage: javelin session start --layer <layer> --agent <type> --session <id>', false)
      const record = repo.sessionStart(layer, { type: agent, sessionId: session })
      return emit(true, { layer: record.name, session })
    }
    case 'trace': {
      const session = str(args, 'session')
      const file = str(args, 'file')
      if (!session || !file) return fail('usage', 'usage: javelin session trace --session <id> --file <path>', false)
      const record = repo.sessionTrace(session, file)
      return emit(true, { layer: record.name, chunks: record.chunks.length })
    }
    case 'subagent': {
      const session = str(args, 'session')
      const task = str(args, 'task')
      const agent = str(args, 'agent')
      if (!session || !task || !agent) return fail('usage', 'usage: javelin session subagent --session <id> --task <id> --agent <type> [--file <path>] [--child-layer <name>]', false)
      const file = str(args, 'file')
      const childLayer = str(args, 'child-layer')
      const record = repo.sessionSubtask(session, {
        taskId: task,
        agentType: agent,
        ...(file ? { tracePath: file } : {}),
        ...(childLayer ? { childLayer } : {}),
      })
      return emit(true, { layer: record.name, subtasks: record.subtasks.length })
    }
    case 'end': {
      const session = str(args, 'session')
      if (!session) return fail('usage', 'usage: javelin session end --session <id> [--file <path>]', false)
      const file = str(args, 'file')
      const record = repo.sessionEnd(session, { ...(file ? { tracePath: file } : {}) })
      return emit(true, { layer: record.name, status: record.status })
    }
    default:
      return fail('usage', 'usage: javelin session <start|trace|subagent|end>', false)
  }
}

async function showCommand(kind: string | undefined, rest: string[], needRepo: NeedRepo, emit: Emit, fail: Fail): Promise<number> {
  const [id] = rest
  const repo = await needRepo()
  switch (kind) {
    case 'world': {
      const seq = num(id)
      const entry = seq !== undefined ? repo.historyEntries().find((e) => e.record.seq === seq) : undefined
      if (!entry) return fail('not-found', `world version ${id} not found`, false)
      const { record } = entry
      const parentTree = record.parent ? worldTreeOf(repo, record.parent) : null
      const changes = parentTree
        ? repo.trees.diffPaths(parentTree, Oid.parse(record.codeTree))
        : []
      return emit(true, {
        seq: record.seq,
        version: entry.id,
        layer: record.layerName,
        at: record.publishedAt,
        note: record.note ?? null,
        contextRoot: record.contextRoot,
        missingContextOverride: record.missingContextOverride ?? false,
        changes: kindChanges(changes),
      })
    }
    case 'layer': {
      if (!id) return fail('usage', 'usage: javelin show layer <name>', false)
      return emit(true, summarizeLayer(repo.layer(id), repo))
    }
    case 'event': {
      if (!id) return fail('usage', 'usage: javelin show event <id>', false)
      const event = repo.timeline.find(id)
      if (!event) return fail('not-found', `event ${id} not found`, false)
      return emit(true, event)
    }
    default:
      return fail('usage', 'usage: javelin show <world|layer|event> <id>', false)
  }
}

function renderHuman(io: Io, commandName: string, ok: boolean, data: unknown): void {
  if (!ok) {
    const err = data as { code?: string; message?: string; conflicts?: ConflictResult['conflicts'] }
    io.stderr(`error [${err.code ?? 'error'}]: ${err.message ?? JSON.stringify(data)}`)
    for (const c of err.conflicts ?? []) {
      io.stderr(`  conflict ${c.type} at ${c.path}: ${c.detail}`)
    }
    if (err.conflicts && err.conflicts.length > 0) {
      io.stderr('the layer is unchanged; edit the layer and retry')
    }
    return
  }
  const d = data as Record<string, unknown>
  switch (commandName) {
    case 'init':
      io.stdout(`initialized javelin repository at world v1`)
      break
    case 'layer create':
    case 'layer clone':
      io.stdout(`${(d as { name: string }).name}\t${(d as { status: string }).status}\tbase v${(d as { baseSeq: number }).baseSeq}`)
      break
    case 'layer open':
      io.stdout(String(d.path))
      break
    case 'layer list':
      for (const l of d.layers as Array<ReturnType<typeof summarizeLayer>>) {
        io.stdout(`${l.name}\t${l.status}\tbase v${l.baseSeq}${l.agent ? `\tagent: ${l.agent}` : ''}`)
      }
      break
    case 'layer status': {
      const layer = d.layer as ReturnType<typeof summarizeLayer>
      io.stdout(`layer ${layer.name} (${layer.status}), base v${layer.baseSeq}`)
      if (d.worldAhead === true) io.stdout('a newer world version exists; publish checks compatibility')
      const unsealed = d.unsealed as string[]
      io.stdout(unsealed.length > 0 ? `unsealed changes (${unsealed.length}): ${unsealed.join(', ')}` : 'no unsealed changes')
      break
    }
    case 'layer delete':
      io.stdout(`deleted ${(d as { deleted: string }).deleted}`)
      break
    case 'diff': {
      const changes = (d.sealed ?? d.changes ?? []) as Array<{ path: string; before: string; after: string }>
      for (const c of changes) io.stdout(`${c.before} -> ${c.after}\t${c.path}`)
      const unsealed = d.unsealed as string[] | undefined
      if (unsealed && unsealed.length > 0) io.stdout(`unsealed: ${unsealed.join(', ')}`)
      break
    }
    case 'stack': {
      const r = d as unknown as StackResult
      io.stdout(`stacked ${r.sources.join(', ')} into ${r.target} (${r.changedPaths.length} paths)`)
      break
    }
    case 'publish': {
      const r = d as unknown as PublishResult
      io.stdout(`published world v${r.seq} (${r.version})`)
      break
    }
    case 'history':
      for (const v of d.versions as Array<{ seq: number; layer: string; at: string; note: string | null }>) {
        io.stdout(`v${v.seq}\t${v.layer}\t${v.at}${v.note ? `\t${v.note}` : ''}`)
      }
      break
    case 'timeline':
      for (const e of d.events as Array<{ seq: number; type: string; at: string }>) {
        io.stdout(`${String(e.seq).padStart(4)}\t${e.type}\t${e.at}`)
      }
      break
    case 'verify':
      io.stdout('ok: repository verified')
      break
    default:
      io.stdout(JSON.stringify(d, null, 2))
  }
}
