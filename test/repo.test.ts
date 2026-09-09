import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync, symlinkSync, appendFileSync } from 'node:fs'
import { Repo, RepositoryError } from '../src/core/repo.ts'
import { objectCount } from '../src/core/objects.ts'
import { Oid } from '../src/core/oids.ts'

const BASE = join(import.meta.dir, '.tmp', 'repo-tests')

function fresh(name: string): { dir: string } {
  const dir = join(BASE, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return { dir }
}

beforeAll(() => {
  mkdirSync(BASE, { recursive: true })
})

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true })
})

async function initRepo(name: string, files: Record<string, string>): Promise<{ repo: Repo; dir: string }> {
  const { dir } = fresh(name)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const repo = await Repo.init(dir)
  return { repo, dir }
}

describe('init', () => {
  test('captures the folder as world v1 with ignore rules applied', async () => {
    const { dir } = fresh('init-basic')
    writeFileSync(join(dir, 'main.ts'), 'console.log(1)\n')
    writeFileSync(join(dir, '.env'), 'SECRET=1\n')
    writeFileSync(join(dir, 'debug.log'), 'noise\n')
    writeFileSync(join(dir, '.javelinignore'), '*.log\n.env\n')
    const repo = await Repo.init(dir)
    const v1 = repo.worldRecord()
    expect(v1.seq).toBe(1)
    const files = repo.trees.listFiles(OidOf(v1.codeTree))
    expect([...files.keys()].sort()).toEqual(['.javelinignore', 'main.ts'])
    expect(repo.timeline.read().map((e) => e.type)).toContain('world.initialized')
  })

  test('seeds .javelinignore from an existing .gitignore', async () => {
    const { dir } = fresh('init-gitignore')
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    writeFileSync(join(dir, 'index.js'), '1\n')
    const repo = await Repo.init(dir)
    expect(readFileSync(join(dir, '.javelinignore'), 'utf8')).toContain('node_modules')
    expect(repo.history()).toHaveLength(1)
  })

  test('refuses to init twice', async () => {
    const { repo, dir } = await initRepo('init-twice', { 'a.txt': 'a\n' })
    void repo
    expect(Repo.init(dir)).rejects.toThrow(RepositoryError)
  })

  test('preserves executable bits and symlinks in identity', async () => {
    const { dir } = fresh('init-modes')
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(join(dir, 'run.sh'), 0o755)
    symlinkSync('run.sh', join(dir, 'link.sh'))
    const repo = await Repo.init(dir)
    const tree = repo.trees.listFiles(OidOf(repo.worldRecord().codeTree))
    expect(tree.get('run.sh')!.kind).toBe('exec')
    expect(tree.get('link.sh')!.kind).toBe('symlink')
  })
})

function OidOf(ref: string): Oid {
  return Oid.parse(ref)
}

describe('layers', () => {
  test('create is metadata-only in the object store plus the workspace projection', async () => {
    const { repo, dir } = await initRepo('layer-create', {
      'src/a.ts': 'a\n',
      'src/b.ts': 'b\n',
      'lib/x.ts': 'x\n',
    })
    const before = objectCount(join(dir, '.javelin', 'objects'))
    await repo.layerCreate('feature')
    const after = objectCount(join(dir, '.javelin', 'objects'))
    expect(after).toBe(before) // no repository copy: zero new objects
    expect(existsSync(join(dir, '.javelin', 'workspaces', 'feature', 'src', 'a.ts'))).toBe(true)
  })

  test('seal captures edits and deletions into a saved root', async () => {
    const { repo, dir } = await initRepo('layer-seal', { 'a.txt': 'v1\n', 'b.txt': 'b\n' })
    await repo.layerCreate('work')
    const ws = join(dir, '.javelin', 'workspaces', 'work')
    writeFileSync(join(ws, 'a.txt'), 'v2\n')
    rmSync(join(ws, 'b.txt'))
    writeFileSync(join(ws, 'c.txt'), 'new\n')
    const { changes } = repo.seal('work')
    expect(changes.size).toBe(3)
    const status = repo.layerStatus('work')
    expect(status.unsealed).toHaveLength(0)
  })

  test('ignore rules never drop tracked content', async () => {
    const { repo, dir } = await initRepo('layer-ignore', { 'keep.txt': 'k\n' })
    writeFileSync(join(dir, '.javelinignore'), '*.log\n')
    await repo.layerCreate('work')
    const ws = join(dir, '.javelin', 'workspaces', 'work')
    writeFileSync(join(ws, 'keep.txt'), 'k2\n')
    writeFileSync(join(ws, 'noise.log'), 'log\n')
    const { changes } = repo.seal('work')
    expect([...changes.keys()].sort()).toEqual(['keep.txt'])
  })

  test('clone is independent of its source', async () => {
    const { repo, dir } = await initRepo('layer-clone', { 'a.txt': 'v1\n' })
    await repo.layerCreate('a')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'a', 'a.txt'), 'v2\n')
    repo.seal('a')
    repo.layerClone('a', 'b')
    const wsB = join(dir, '.javelin', 'workspaces', 'b')
    expect(readFileSync(join(wsB, 'a.txt'), 'utf8')).toBe('v2\n')
    writeFileSync(join(wsB, 'a.txt'), 'v3\n')
    repo.seal('b')
    expect(readFileSync(join(dir, '.javelin', 'workspaces', 'a', 'a.txt'), 'utf8')).toBe('v2\n')
  })

  test('delete removes active layers but refuses published ones', async () => {
    const { repo, dir } = await initRepo('layer-delete', { 'a.txt': 'v1\n' })
    await repo.layerCreate('temp')
    repo.layerDelete('temp')
    expect(repo.layerNames()).toHaveLength(0)
    await repo.layerCreate('keep')
    repo.publish('keep')
    expect(() => repo.layerDelete('keep')).toThrow(RepositoryError)
    void dir
  })
})

describe('publish', () => {
  test('a clean layer becomes the next immutable world version', async () => {
    const { repo, dir } = await initRepo('publish-clean', { 'a.txt': 'v1\n' })
    await repo.layerCreate('work')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'work', 'a.txt'), 'v2\n')
    const result = repo.publish('work')
    expect(result.status).toBe('published')
    if (result.status === 'published') {
      expect(result.seq).toBe(2)
      const v2 = repo.worldRecord(result.version)
      expect(v2.parent).not.toBeNull()
      expect(v2.layerName).toBe('work')
    }
    expect(existsSync(join(dir, '.javelin', 'workspaces', 'work'))).toBe(false)
  })

  test('publish shares all unchanged objects structurally', async () => {
    const { repo, dir } = await initRepo('publish-sharing', {
      'src/a.ts': 'a\n',
      'src/b.ts': 'b\n',
      'docs/readme.md': 'readme\n',
    })
    const before = objectCount(join(dir, '.javelin', 'objects'))
    await repo.layerCreate('work')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'work', 'src', 'a.ts'), 'a2\n')
    repo.publish('work')
    const after = objectCount(join(dir, '.javelin', 'objects'))
    // Exactly: one blob, the rewritten src tree, the root tree, the version
    // record. The docs subtree and b.ts blob are shared, not copied.
    expect(after - before).toBe(4)
  })

  test('replay with the same operation id returns the original result', async () => {
    const { repo, dir } = await initRepo('publish-idempotent', { 'a.txt': 'v1\n' })
    await repo.layerCreate('work')
    const result = repo.publish('work', { operationId: 'op-1' })
    expect(result.status).toBe('published')
    const replay = repo.publish('work', { operationId: 'op-1' })
    expect(replay).toEqual(result)
    expect(repo.history()).toHaveLength(2)
  })

  test('disjoint changes publish onto a newer world without refresh', async () => {
    const { repo, dir } = await initRepo('publish-disjoint', { 'a.txt': 'v1\n', 'b.txt': 'b1\n' })
    await repo.layerCreate('slow')
    await repo.layerCreate('fast')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'fast', 'b.txt'), 'b2\n')
    repo.publish('fast')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'slow', 'a.txt'), 'v2\n')
    const result = repo.publish('slow')
    expect(result.status).toBe('published')
    const files = repo.trees.listFiles(OidOf(repo.worldRecord().codeTree))
    expect(new TextDecoder().decode(repo.trees.readBlob(files.get('a.txt')!.oid))).toBe('v2\n')
    expect(new TextDecoder().decode(repo.trees.readBlob(files.get('b.txt')!.oid))).toBe('b2\n')
  })

  test('overlapping changes reject publish with structured conflicts', async () => {
    const { repo, dir } = await initRepo('publish-conflict', { 'a.txt': 'v1\n' })
    await repo.layerCreate('slow')
    await repo.layerCreate('fast')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'fast', 'a.txt'), 'fast\n')
    repo.publish('fast')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'slow', 'a.txt'), 'slow\n')
    const result = repo.publish('slow')
    expect(result.status).toBe('conflict')
    if (result.status === 'conflict') {
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]!.path).toBe('a.txt')
      expect(result.conflicts[0]!.type).toBe('content')
    }
    expect(repo.history()).toHaveLength(2) // nothing published
    expect(repo.layer('slow').status).toBe('active')
  })

  test('revert creates a new version instead of moving a pointer back', async () => {
    const { repo, dir } = await initRepo('publish-revert', { 'a.txt': 'good\n' })
    await repo.layerCreate('break')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'break', 'a.txt'), 'bad\n')
    repo.publish('break')
    await repo.layerCreate('fix')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'fix', 'a.txt'), 'good\n')
    repo.publish('fix')
    const head = repo.worldRecord()
    expect(head.seq).toBe(3)
    expect(new TextDecoder().decode(repo.trees.readBlob(repo.trees.listFiles(OidOf(head.codeTree)).get('a.txt')!.oid))).toBe('good\n')
  })

  test('agent layers require context; the override is recorded', async () => {
    const { repo, dir } = await initRepo('publish-context', { 'a.txt': 'v1\n' })
    await repo.layerCreate('agentic', { agent: { type: 'codex', sessionId: 's-1' } })
    writeFileSync(join(dir, '.javelin', 'workspaces', 'agentic', 'a.txt'), 'v2\n')
    expect(() => repo.publish('agentic')).toThrow(RepositoryError)
    repo.publish('agentic', { allowMissingContext: true })
    const head = repo.worldRecord()
    expect(head.missingContextOverride).toBe(true)
    expect(repo.timeline.read().map((e) => e.type)).toContain('context.missing.override')
  })
})

describe('sessions and context', () => {
  test('session traces seal code and context together', async () => {
    const { repo, dir } = await initRepo('session-flow', { 'a.txt': 'v1\n' })
    await repo.layerCreate('agentic')
    repo.sessionStart('agentic', { type: 'claude', sessionId: 'sess-9' })
    const ws = join(dir, '.javelin', 'workspaces', 'agentic')
    writeFileSync(join(ws, 'a.txt'), 'v2\n')
    const trace = join(dir, 'trace.jsonl')
    writeFileSync(trace, '{"event":"turn_start"}\n{"event":"edit"}\n')
    repo.sessionTrace('sess-9', trace)
    repo.sessionEnd('sess-9')
    const record = repo.layer('agentic')
    expect(record.status).toBe('ready')
    expect(record.chunks).toHaveLength(1)
    const result = repo.publish('agentic')
    expect(result.status).toBe('published')
    const head = repo.worldRecord()
    expect(head.contextRoot).not.toBeNull()
    expect(head.missingContextOverride).toBeUndefined()
  })

  test('subagent traces nest under the parent session', async () => {
    const { repo, dir } = await initRepo('session-subtask', { 'a.txt': 'v1\n' })
    await repo.layerCreate('parent')
    repo.sessionStart('parent', { type: 'codex', sessionId: 's-p' })
    const childTrace = join(dir, 'child.jsonl')
    writeFileSync(childTrace, '{"sub":true}\n')
    repo.sessionSubtask('s-p', { taskId: 't-1', agentType: 'codex', tracePath: childTrace })
    const record = repo.layer('parent')
    expect(record.subtasks).toHaveLength(1)
    expect(record.subtasks[0]!.chunks).toHaveLength(1)
    void dir
  })
})

describe('stack', () => {
  test('independent layers combine atomically into the target', async () => {
    const { repo, dir } = await initRepo('stack-clean', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
    await repo.layerCreate('sa')
    await repo.layerCreate('sb')
    await repo.layerCreate('main-work')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'sa', 'a.txt'), 'a2\n')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'sb', 'b.txt'), 'b2\n')
    const result = repo.stack(['sa', 'sb'], 'main-work')
    expect(result.status).toBe('stacked')
    const ws = join(dir, '.javelin', 'workspaces', 'main-work')
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a2\n')
    expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('b2\n')
    expect(repo.history()).toHaveLength(1) // stack never touches the world
  })

  test('a conflict leaves the target exactly as it was', async () => {
    const { repo, dir } = await initRepo('stack-conflict', { 'a.txt': 'base\n' })
    await repo.layerCreate('s1')
    await repo.layerCreate('target')
    writeFileSync(join(dir, '.javelin', 'workspaces', 's1', 'a.txt'), 's1\n')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'target', 'a.txt'), 'local\n')
    repo.seal('target')
    const before = repo.layer('target').savedRoot
    const result = repo.stack(['s1'], 'target')
    expect(result.status).toBe('conflict')
    if (result.status === 'conflict') expect(result.conflicts[0]!.type).toBe('content')
    expect(repo.layer('target').savedRoot).toBe(before)
  })

  test('declared ancestry applies parent before child', async () => {
    const { repo, dir } = await initRepo('stack-ancestry', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
    await repo.layerCreate('parent-work')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'parent-work', 'a.txt'), 'a-parent\n')
    repo.seal('parent-work')
    await repo.layerCreate('child-work', { parent: 'parent-work' })
    writeFileSync(join(dir, '.javelin', 'workspaces', 'child-work', 'b.txt'), 'b-child\n')
    repo.seal('child-work')
    await repo.layerCreate('integrator')
    const result = repo.stack(['child-work', 'parent-work'], 'integrator')
    expect(result.status).toBe('stacked')
    const ws = join(dir, '.javelin', 'workspaces', 'integrator')
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a-parent\n')
    expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('b-child\n')
  })
})

describe('review regressions', () => {
  test('a directory replaced by a file publishes cleanly', async () => {
    const { repo, dir } = await initRepo('regress-dir-to-file', { 'a/inner.txt': 'x\n' })
    await repo.layerCreate('work')
    const ws = join(dir, '.javelin', 'workspaces', 'work')
    rmSync(join(ws, 'a'), { recursive: true })
    writeFileSync(join(ws, 'a'), 'now a file\n')
    const result = repo.publish('work')
    expect(result.status).toBe('published')
    const files = repo.trees.listFiles(OidOf(repo.worldRecord().codeTree))
    expect([...files.keys()]).toEqual(['a'])
    expect(files.get('a')!.kind).toBe('file')
  })

  test('a broken symlink stays present and stable across seals', async () => {
    const { repo, dir } = await initRepo('regress-broken-link', { 'real.txt': 'r\n' })
    await repo.layerCreate('work')
    const ws = join(dir, '.javelin', 'workspaces', 'work')
    symlinkSync('/definitely/missing/target', join(ws, 'stub'))
    repo.seal('work')
    const afterFirst = repo.trees.listFiles(OidOf(repo.layer('work').savedRoot!))
    expect(afterFirst.has('stub')).toBe(true)
    repo.seal('work')
    const afterSecond = repo.trees.listFiles(OidOf(repo.layer('work').savedRoot!))
    expect(afterSecond.has('stub')).toBe(true)
  })

  test('directory-only ignore rules prune new directories', async () => {
    const { repo, dir } = await initRepo('regress-dir-ignore', { 'keep.txt': 'k\n' })
    writeFileSync(join(dir, '.javelinignore'), 'logs/\nnode_modules/\n')
    await repo.layerCreate('work')
    const ws = join(dir, '.javelin', 'workspaces', 'work')
    mkdirSync(join(ws, 'logs'), { recursive: true })
    mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(ws, 'logs', 'out.log'), 'noise\n')
    writeFileSync(join(ws, 'node_modules', 'pkg', 'index.js'), 'module\n')
    const { changes } = repo.seal('work')
    expect(changes.size).toBe(0)
  })

  test('a running operation file from a dead process is adopted, not wedged', async () => {
    const { repo, dir } = await initRepo('regress-ops-adopt', { 'a.txt': 'v1\n' })
    await repo.layerCreate('w')
    mkdirSync(join(dir, '.javelin', 'ops'), { recursive: true })
    writeFileSync(
      join(dir, '.javelin', 'ops', 'crash-1.json'),
      JSON.stringify({ status: 'running', pid: 999_999_999, at: new Date().toISOString() }),
    )
    const result = repo.publish('w', { operationId: 'crash-1' })
    expect(result.status).toBe('published')
    const replay = repo.publish('w', { operationId: 'crash-1' })
    expect(replay).toEqual(result)
    expect(repo.history()).toHaveLength(2)
  })

  test('a failed publish without mutation releases its operation id', async () => {
    const { repo, dir } = await initRepo('regress-ops-release', { 'a.txt': 'v1\n' })
    await repo.layerCreate('bot', { agent: { type: 'codex', sessionId: 's-1' } })
    writeFileSync(join(dir, '.javelin', 'workspaces', 'bot', 'a.txt'), 'v2\n')
    expect(() => repo.publish('bot', { operationId: 'doomed' })).toThrow(RepositoryError)
    // The same id works again once the condition is resolved.
    writeFileSync(join(dir, 'trace.jsonl'), '{"turn":1}\n')
    repo.sessionTrace('s-1', join(dir, 'trace.jsonl'))
    const result = repo.publish('bot', { operationId: 'doomed' })
    expect(result.status).toBe('published')
  })

  test('a torn final timeline line is truncated, earlier corruption throws', async () => {
    const { repo, dir } = await initRepo('regress-torn-timeline', { 'a.txt': 'v1\n' })
    const timelinePath = join(dir, '.javelin', 'timeline.jsonl')
    const before = readFileSync(timelinePath, 'utf8')
    appendFileSync(timelinePath, '{"seq":99,"type":"layer.cr')
    expect(() => repo.timeline.read()).not.toThrow()
    appendFileSync(timelinePath, '\n')
    const events = repo.timeline.read()
    expect(events[events.length - 1]!.seq).toBe(1)
    void before
    writeFileSync(timelinePath, '{"broken\nnot-the-last-line\n')
    expect(() => repo.timeline.read()).toThrow()
  })

  test('crashed ref temp files never appear as layers', async () => {
    const { repo, dir } = await initRepo('regress-tmp-layer', { 'a.txt': 'v1\n' })
    await repo.layerCreate('real')
    writeFileSync(join(dir, '.javelin', 'refs', 'layers', 'ghost.tmp-123-456'), 'junk')
    expect(repo.layerNames()).toEqual(['real'])
  })
})

describe('verify', () => {
  test('quick and full verification pass on a healthy repository', async () => {
    const { repo } = await initRepo('verify-ok', { 'a.txt': 'a\n', 'd/b.txt': 'b\n' })
    expect(repo.verify('quick')).toEqual({ ok: true, problems: [] })
    expect(repo.verify('full')).toEqual({ ok: true, problems: [] })
  })

  test('full verification detects a corrupted blob', async () => {
    const { repo, dir } = await initRepo('verify-corrupt', { 'a.txt': 'a\n' })
    await repo.layerCreate('w')
    repo.publish('w')
    // Corrupt the a.txt blob on disk.
    const objects = join(dir, '.javelin', 'objects')
    const head = repo.worldRecord()
    const entry = repo.trees.listFiles(OidOf(head.codeTree)).get('a.txt')!
    const blobPath = join(objects, entry.oid.hex.slice(0, 2), entry.oid.hex.slice(2))
    writeFileSync(blobPath, 'tampered\n')
    const report = repo.verify('full')
    expect(report.ok).toBe(false)
    expect(report.problems.length).toBeGreaterThan(0)
  })
})

describe('history and timeline', () => {
  test('history walks the accepted chain newest first', async () => {
    const { repo, dir } = await initRepo('history', { 'a.txt': 'v1\n' })
    await repo.layerCreate('w')
    writeFileSync(join(dir, '.javelin', 'workspaces', 'w', 'a.txt'), 'v2\n')
    repo.publish('w')
    const chain = repo.history()
    expect(chain.map((r) => r.seq)).toEqual([2, 1])
    expect(chain[0]!.parent).not.toBeNull()
  })

  test('the timeline records the meaningful events', async () => {
    const { repo, dir } = await initRepo('timeline-events', { 'a.txt': 'v1\n' })
    await repo.layerCreate('w')
    repo.publish('w')
    const types = repo.timeline.read().map((e) => e.type)
    expect(types).toContain('world.initialized')
    expect(types).toContain('layer.created')
    expect(types).toContain('layer.published')
    expect(types).toContain('world.version.created')
  })
})
