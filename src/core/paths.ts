// Portable path rules for repository content. The stored spelling is the
// user's own; the comparison key is a versioned algorithm so the same
// repository rejects case-folded and Unicode-normalized collisions on every
// platform regardless of what the host filesystem would tolerate.

export class InvalidPathError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`invalid path ${JSON.stringify(path)}: ${reason}`)
  }
}

// PATH-KEY-V1: NFC normalization followed by lowercase. Frozen for
// repository format version 1; a future format version may define another
// algorithm, but keys are never mixed inside one repository.
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

export function validatePath(path: string): void {
  if (path === '') throw new InvalidPathError(path, 'empty')
  if (path.includes('\0')) throw new InvalidPathError(path, 'NUL byte')
  if (path.includes('\\')) throw new InvalidPathError(path, 'backslash is a Windows separator')
  if (path.startsWith('/') || path.endsWith('/')) {
    throw new InvalidPathError(path, 'must be relative without trailing slash')
  }
  if (path.split('/').some((s) => s === '')) {
    throw new InvalidPathError(path, 'empty path segment')
  }
  if (path.split('/').some((s) => s === '.' || s === '..')) {
    throw new InvalidPathError(path, 'dot segments are not portable')
  }
  for (const ch of path) {
    if (ch.charCodeAt(0) < 0x20) throw new InvalidPathError(path, 'control character')
  }
}

export function assertNoCollisions(paths: Iterable<string>): void {
  const seen = new Map<string, string>()
  for (const p of paths) {
    const key = pathKey(p)
    const existing = seen.get(key)
    if (existing !== undefined) {
      throw new InvalidPathError(
        p,
        `collides with ${JSON.stringify(existing)} under the portable path key`,
      )
    }
    seen.set(key, p)
  }
}
