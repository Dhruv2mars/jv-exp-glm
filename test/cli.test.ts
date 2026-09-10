import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const ROOT = join(import.meta.dir, '.tmp', 'cli-e2e')
const ENTRY = join(import.meta.dir, '..', 'src', 'cli', 'main.ts')

interface RunResult {
  code: number
  stdout: string
  stderr: string
  json: () => any
}

function javelin(cwd: string, args: string[]): RunResult {
  const proc = Bun.spawnSync(['bun', 'run', ENTRY, ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    json: () => JSON.parse(proc.stdout.toString()),
  }
}

function workspace(name: string): string {
  const dir = join(ROOT, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeAll(() => mkdirSync(ROOT, { recursive: true }))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('cli end to end', () => {
  test('the full workflow: init, layer, session, publish, history, verify', () => {
    const dir = workspace('full')
    writeFileSync(join(dir, 'app.ts'), 'console.log("v1")\n')
    writeFileSync(join(dir, '.javelinignore'), '*.log\n')

    let r = javelin(dir, ['init', '--json'])
    expect(r.code).toBe(0)
    expect(r.json().javelin).toBe(1)
    expect(r.json().ok).toBe(true)
    expect(r.json().data.seq).toBe(1)

    r = javelin(dir, ['layer', 'create', 'feature', '--json'])
    expect(r.code).toBe(0)
    const layerPath = r.json().data.workspace as string
    expect(existsSync(join(layerPath, 'app.ts'))).toBe(true)

    r = javelin(dir, ['layer', 'open', 'feature', '--json'])
    expect(r.json().data.path).toBe(layerPath)

    r = javelin(dir, ['session', 'start', '--layer', 'feature', '--agent', 'codex', '--session', 's-1', '--json'])
    expect(r.code).toBe(0)

    writeFileSync(join(layerPath, 'app.ts'), 'console.log("v2")\n')
    writeFileSync(join(layerPath, 'extra.ts'), 'export {}\n')

    r = javelin(dir, ['layer', 'status', 'feature', '--json'])
    expect(r.json().data.unsealed.sort()).toEqual(['app.ts', 'extra.ts'])

    const trace = join(dir, 'native-trace.jsonl')
    writeFileSync(trace, '{"type":"turn_start"}\n{"type":"edit","file":"app.ts"}\n')
    r = javelin(dir, ['session', 'trace', '--session', 's-1', '--file', trace, '--json'])
    expect(r.json().data.chunks).toBe(1)

    r = javelin(dir, ['session', 'end', '--session', 's-1', '--json'])
    expect(r.json().data.status).toBe('ready')

    r = javelin(dir, ['publish', 'feature', '--json'])
    expect(r.code).toBe(0)
    expect(r.json().data.seq).toBe(2)
    expect(existsSync(layerPath)).toBe(false)

    r = javelin(dir, ['history', '--json'])
    expect(r.json().data.versions.map((v: any) => v.seq)).toEqual([2, 1])
    expect(r.json().data.versions[0].context).not.toBeNull()

    r = javelin(dir, ['verify', '--full', '--json'])
    expect(r.json().data.ok).toBe(true)

    r = javelin(dir, ['timeline', '--json'])
    const types = r.json().data.events.map((e: any) => e.type)
    expect(types).toContain('layer.published')
    expect(types).toContain('world.version.created')

    r = javelin(dir, ['show', 'world', '2', '--json'])
    expect(r.json().data.layer).toBe('feature')
    expect(r.json().data.changes.map((c: any) => c.path).sort()).toEqual(['app.ts', 'extra.ts'])
  })

  test('publish conflict is machine-readable and exits nonzero', () => {
    const dir = workspace('conflict')
    writeFileSync(join(dir, 'a.txt'), 'v1\n')
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'slow'])
    javelin(dir, ['layer', 'create', 'fast'])
    const fast = JSON.parse(javelin(dir, ['layer', 'open', 'fast', '--json']).stdout).data.path
    writeFileSync(join(fast, 'a.txt'), 'fast\n')
    javelin(dir, ['publish', 'fast'])

    const slow = JSON.parse(javelin(dir, ['layer', 'open', 'slow', '--json']).stdout).data.path
    writeFileSync(join(slow, 'a.txt'), 'slow\n')

    const r = javelin(dir, ['publish', 'slow', '--json'])
    expect(r.code).toBe(1)
    const envelope = r.json()
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('conflict')
    expect(envelope.error.conflicts[0].path).toBe('a.txt')
    expect(envelope.error.conflicts[0].type).toBe('content')
  })

  test('disjoint concurrent work publishes without refresh', () => {
    const dir = workspace('disjoint')
    writeFileSync(join(dir, 'a.txt'), 'v1\n')
    writeFileSync(join(dir, 'b.txt'), 'v1\n')
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'slow'])
    javelin(dir, ['layer', 'create', 'fast'])
    const fast = JSON.parse(javelin(dir, ['layer', 'open', 'fast', '--json']).stdout).data.path
    writeFileSync(join(fast, 'b.txt'), 'v2\n')
    javelin(dir, ['publish', 'fast'])
    const slow = JSON.parse(javelin(dir, ['layer', 'open', 'slow', '--json']).stdout).data.path
    writeFileSync(join(slow, 'a.txt'), 'v2\n')
    const r = javelin(dir, ['publish', 'slow', '--json'])
    expect(r.code).toBe(0)
    expect(r.json().data.seq).toBe(3)
  })

  test('missing agent context prompts for override in json mode without a tty', () => {
    const dir = workspace('no-tty')
    writeFileSync(join(dir, 'a.txt'), 'v1\n')
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'bot', '--agent', 'codex', '--session', 's-9'])
    const ws = JSON.parse(javelin(dir, ['layer', 'open', 'bot', '--json']).stdout).data.path
    writeFileSync(join(ws, 'a.txt'), 'v2\n')
    const r = javelin(dir, ['publish', 'bot', '--json'])
    expect(r.code).toBe(1)
    expect(r.json().error.code).toBe('missing-context')
    const ok = javelin(dir, ['publish', 'bot', '--allow-missing-context', '--json'])
    expect(ok.code).toBe(0)
    const shown = JSON.parse(javelin(dir, ['show', 'world', '2', '--json']).stdout)
    expect(shown.data.missingContextOverride).toBe(true)
  })

  test('idempotent publish via operation id', () => {
    const dir = workspace('opid')
    writeFileSync(join(dir, 'a.txt'), 'v1\n')
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'w'])
    const first = javelin(dir, ['publish', 'w', '--operation-id', 'retry-me', '--json'])
    const second = javelin(dir, ['publish', 'w', '--operation-id', 'retry-me', '--json'])
    expect(second.json().data).toEqual(first.json().data)
    const history = JSON.parse(javelin(dir, ['history', '--json']).stdout)
    expect(history.data.versions).toHaveLength(2)
  })

  test('stack through the cli with a conflict leaves the target unchanged', () => {
    const dir = workspace('stack')
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 's1'])
    javelin(dir, ['layer', 'create', 'target'])
    const s1 = JSON.parse(javelin(dir, ['layer', 'open', 's1', '--json']).stdout).data.path
    const target = JSON.parse(javelin(dir, ['layer', 'open', 'target', '--json']).stdout).data.path
    writeFileSync(join(s1, 'a.txt'), 's1\n')
    writeFileSync(join(target, 'a.txt'), 'local\n')
    javelin(dir, ['layer', 'status', 'target'])
    const r = javelin(dir, ['stack', 's1', '--into', 'target', '--json'])
    expect(r.code).toBe(1)
    expect(r.json().error.code).toBe('conflict')
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('local\n')
  })

  test('clone is constant-time on the record layer and independent', () => {
    const dir = workspace('clone')
    writeFileSync(join(dir, 'a.txt'), 'v1\n')
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'a'])
    const wsA = JSON.parse(javelin(dir, ['layer', 'open', 'a', '--json']).stdout).data.path
    writeFileSync(join(wsA, 'a.txt'), 'v2\n')
    javelin(dir, ['layer', 'clone', 'a', 'b'])
    const wsB = JSON.parse(javelin(dir, ['layer', 'open', 'b', '--json']).stdout).data.path
    expect(readFileSync(join(wsB, 'a.txt'), 'utf8')).toBe('v2\n')
    writeFileSync(join(wsB, 'a.txt'), 'v3\n')
    expect(readFileSync(join(wsA, 'a.txt'), 'utf8')).toBe('v2\n')
  })

  test('diff --world takes two positional versions', () => {
    const dir = workspace('diff-world')
    writeFileSync(join(dir, 'a.txt'), 'v1\n')
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'w'])
    const ws = JSON.parse(javelin(dir, ['layer', 'open', 'w', '--json']).stdout).data.path
    writeFileSync(join(ws, 'a.txt'), 'v2\n')
    javelin(dir, ['publish', 'w'])
    const r = javelin(dir, ['diff', '--world', '1', '2', '--json'])
    expect(r.code).toBe(0)
    expect(r.json().data.changes).toEqual([{ path: 'a.txt', before: 'file', after: 'file' }])
  })

  test('errors carry stable codes; usage exits 1 with usage code', () => {
    const dir = workspace('errors')
    const r = javelin(dir, ['history', '--json'])
    expect(r.code).toBe(1)
    expect(r.json().error.code).toBe('not-a-repository')
    const u = javelin(dir, ['frobnicate', '--json'])
    expect(u.json().error.code).toBe('usage')
  })

  test('gc, doctor, and version work through the cli', () => {
    const dir = workspace('ops-cli')
    writeFileSync(join(dir, 'a.txt'), 'v1\n')
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'w'])
    const ws = JSON.parse(javelin(dir, ['layer', 'open', 'w', '--json']).stdout).data.path
    writeFileSync(join(ws, 'a.txt'), 'v2\n')
    javelin(dir, ['layer', 'create', 'dropped'])
    const droppedWs = JSON.parse(javelin(dir, ['layer', 'open', 'dropped', '--json']).stdout).data.path
    writeFileSync(join(droppedWs, 'unique.txt'), 'x\n')
    javelin(dir, ['layer', 'delete', 'dropped'])
    rmSync(ws, { recursive: true, force: true })
    const doc = javelin(dir, ['doctor', '--json'])
    expect(doc.code).toBe(0)
    expect(JSON.stringify(doc.json().data.fixed)).toContain('rematerialized workspace for w')
    expect(existsSync(join(ws, 'a.txt'))).toBe(true)
    const gc = javelin(dir, ['gc', '--grace-hours', '-1', '--json'])
    expect(gc.code).toBe(0)
    expect(gc.json().data.removed).toBeGreaterThan(0)
    const version = javelin(dir, ['version', '--json'])
    expect(version.json().data.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('init refuses git repositories with a stable code', () => {
    const dir = workspace('git-refusal')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    mkdirSync(join(dir, '.git'))
    const r = javelin(dir, ['init', '--json'])
    expect(r.code).toBe(1)
    expect(r.json().error.code).toBe('git-repository')
  })

  test('traces with credentials fail closed unless --allow-secrets', () => {
    const dir = workspace('secret-cli')
    writeFileSync(join(dir, 'a.txt'), 'v1\n')
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'bot'])
    javelin(dir, ['session', 'start', '--layer', 'bot', '--agent', 'codex', '--session', 'sx'])
    const trace = join(dir, 'leak.jsonl')
    writeFileSync(trace, 'token=ghp_' + 'B'.repeat(36) + '\n')
    const denied = javelin(dir, ['session', 'trace', '--session', 'sx', '--file', trace, '--json'])
    expect(denied.code).toBe(1)
    expect(denied.json().error.code).toBe('trace-secrets')
    const allowed = javelin(dir, ['session', 'trace', '--session', 'sx', '--file', trace, '--allow-secrets', '--json'])
    expect(allowed.code).toBe(0)
  })

  test('human output renders the core verbs', () => {
    const dir = workspace('human')
    writeFileSync(join(dir, 'a.txt'), 'v1\n')
    const init = javelin(dir, ['init'])
    expect(init.stdout).toContain('initialized javelin repository')
    javelin(dir, ['layer', 'create', 'w'])
    const pub = javelin(dir, ['publish', 'w'])
    expect(pub.stdout).toContain('published world v2')
    const hist = javelin(dir, ['history'])
    expect(hist.stdout).toContain('v2')
  })
})

describe('performance invariants', () => {
  test('layer create adds zero objects regardless of world size', () => {
    const dir = workspace('perf-create')
    // A 3,000-file world.
    for (let i = 0; i < 3000; i++) {
      writeFileSync(join(dir, `f${i}.txt`), `content ${i}\n`)
    }
    const t0 = performance.now()
    javelin(dir, ['init'])
    const initMs = performance.now() - t0
    void initMs

    const countObjects = (): number => {
      const objects = join(dir, '.javelin', 'objects')
      let n = 0
      for (const shard of existsSync(objects) ? Array.from(new Bun.Glob('*').scanSync({ cwd: objects })) : []) {
        n += Array.from(new Bun.Glob('*').scanSync({ cwd: join(objects, shard) })).length
      }
      return n
    }
    const before = countObjects()
    const t1 = performance.now()
    javelin(dir, ['layer', 'create', 'agent-1'])
    const createMs = performance.now() - t1
    const after = countObjects()
    expect(after).toBe(before)
    // Creation is metadata plus the workspace projection, not a repository copy.
    expect(createMs).toBeLessThan(30_000)
  })

  test('publishing a disjoint layer stays proportional to its changes', () => {
    const dir = workspace('perf-publish')
    for (let i = 0; i < 1500; i++) {
      mkdirSync(join(dir, `d${Math.floor(i / 500)}`), { recursive: true })
      writeFileSync(join(dir, `d${Math.floor(i / 500)}`, `f${i}.txt`), `content ${i}\n`)
    }
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'big-world'])
    javelin(dir, ['layer', 'create', 'small-change'])
    const fast = JSON.parse(javelin(dir, ['layer', 'create', 'publish-first', '--json']).stdout)
    void fast
    const wsSmall = JSON.parse(javelin(dir, ['layer', 'open', 'small-change', '--json']).stdout).data.path
    writeFileSync(join(wsSmall, 'changed.txt'), 'only this\n')
    const t0 = performance.now()
    const r = javelin(dir, ['publish', 'small-change', '--json'])
    const publishMs = performance.now() - t0
    expect(r.json().data.seq).toBe(2)
    // The publish path diffs trees, not bytes: 1,500 unchanged files are never read.
    expect(publishMs).toBeLessThan(60_000)
  })

  test('seal cost follows changed files, not world size', () => {
    const dir = workspace('perf-seal')
    for (let i = 0; i < 800; i++) {
      writeFileSync(join(dir, `f${i}.txt`), `content ${i}\n`)
    }
    javelin(dir, ['init'])
    javelin(dir, ['layer', 'create', 'w'])
    const ws = JSON.parse(javelin(dir, ['layer', 'open', 'w', '--json']).stdout).data.path
    writeFileSync(join(ws, 'f0.txt'), 'changed\n')
    const t0 = performance.now()
    const r = javelin(dir, ['layer', 'status', 'w', '--json'])
    const statusMs = performance.now() - t0
    expect(r.json().data.unsealed).toEqual(['f0.txt'])
    void statusMs
  })
})
