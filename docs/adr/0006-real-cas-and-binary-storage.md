# ADR 0006: Real cross-process CAS for mutable heads; binary-safe storage

Date: 2026-09-09. Status: accepted. Amends ADR 0002 (v1 relied on in-process locks).

## Context
The only mutable state in a Javelin repository is small: the world head, layer heads, contribution status. v1 guarded ref updates with an in-process promise chain, which is not mutual exclusion across processes or replicas. Blob storage is raw bytes locally, but v1 tree entries lost the executable bit to a bridge sidecar.

## Decision
- A `MetaStore` owns every mutable pointer under `.javelin/meta/`. Its only write primitive is `compareAndSwap(key, expected, next)` (plus create/delete/list).
- Local implementation: cross-process mutual exclusion via `O_EXCL` lockfile acquisition with bounded retry and stale-lock theft (lock mtime older than a threshold), then read-compare-write-rename inside the lock. Crash safety: temp file + atomic rename; a crash mid-swap leaves either the old or the new value, and a leftover lock is stolen after the staleness threshold.
- The `Heads` interface is the seam for the hosted data plane: javelind nodes are replaceable compute/cache; durable repository truth (immutable objects + authoritative heads) lives behind this interface so a strongly-consistent store can replace the lockfile implementation without touching callers. We deliberately do not choose S3/R2/a metadata DB yet; the abstraction is benchmarked first.
- `TreeEntry.mode` (file/exec/symlink) is part of the canonical tree encoding, so the executable bit is content-addressed, not sidecar'd.

## Alternatives
- SQLite for metadata: viable locally, but adds a native dependency and does not solve the multi-replica case either; the Heads seam solves both later.
- Optimistic concurrency without locks (versioned files + rename-if-absent): tempting, but rename-based CAS is not portable across filesystems; lockfile + compare inside the lock is portable and simple.

## Consequences
- Concurrent CLI processes on one repository are now safe (the concurrent-agents case).
- Multi-replica javelind still needs the durable Heads implementation; until then, single-writer javelind is the documented deployment shape.
- Stale-lock theft trades a 10s stall for liveness after a crash; documented in operations.
