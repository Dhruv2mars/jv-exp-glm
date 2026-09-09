import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// .javelinignore controls discovery of NEW unversioned paths only. It never
// removes content that already exists in a base World version or in a
// layer's own overlay; removing tracked content requires an explicit delete
// inside the layer.

interface Rule {
  negated: boolean
  dirOnly: boolean
  anchored: boolean
  regex: RegExp
}

export class IgnoreRules {
  private rules: Rule[]

  constructor(patterns: string[]) {
    this.rules = []
    for (const raw of patterns) {
      const line = raw.replace(/\r$/, '')
      if (line === '' || line.startsWith('#')) continue
      let body = line
      let negated = false
      if (body.startsWith('!')) {
        negated = true
        body = body.slice(1)
      }
      let dirOnly = false
      if (body.endsWith('/') && body !== '/') {
        dirOnly = true
        body = body.slice(0, -1)
      }
      if (body === '') continue
      let anchored = false
      if (body.startsWith('/')) {
        anchored = true
        body = body.slice(1)
      } else if (body.includes('/')) {
        anchored = true
      }
      if (body === '') continue
      this.rules.push({ negated, dirOnly, anchored, regex: globToRegex(body) })
    }
  }

  static load(dir: string, fileName = '.javelinignore'): IgnoreRules {
    const path = join(dir, fileName)
    if (!existsSync(path)) return new IgnoreRules([])
    return new IgnoreRules(readFileSync(path, 'utf8').split('\n'))
  }

  // Later rules win, matching gitignore's last-match behavior. Directory
  // matches prune whole subtrees because the walker stops descending.
  matched(path: string, isDir = false): boolean {
    let ignored = false
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue
      const target = rule.anchored ? path : path.replace(/^.*\//, '')
      if (rule.regex.test(target)) ignored = !rule.negated
    }
    return ignored
  }
}

export function globToRegex(glob: string): RegExp {
  let source = '^'
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*' && glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 3
        continue
      }
      if (glob[i + 1] === '*') {
        source += '.*'
        i += 2
        continue
      }
      source += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      source += '[^/]'
      i += 1
      continue
    }
    if ('\\^$.|+()[]{}'.includes(ch)) {
      source += `\\${ch}`
      i += 1
      continue
    }
    source += ch
    i += 1
  }
  return new RegExp(`${source}$`)
}

// init convenience: an existing .gitignore seeds .javelinignore verbatim.
// The common rules are compatible; exotic patterns can be adjusted by hand.
export function translateGitignore(content: string): string {
  return `# seeded from .gitignore by javelin init\n${content}`
}
