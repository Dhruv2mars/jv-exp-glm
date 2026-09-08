# ADR 0002: Content-addressed object store with sha256

Date: 2026-09-09. Status: accepted.

## Context
The VCS needs immutable, deduplicated, verifiable objects (blob, tree, commit, plus later: provenance, evidence). javelind needs to accept objects from untrusted clients without corruption.

## Decision
Objects are serialized with a type tag and canonical JSON/binary framing, addressed by their sha256, stored as loose files sharded by the first two hex characters. All writes go to a temp file then atomic rename. Refs are small files (or server-side JSON) updated by atomic rename; remote ref updates require the expected current value (compare-and-swap).

## Alternatives
- Git's own object format: rejected, interop belongs in the bridge, and the native format should carry provenance/evidence natively.
- A database for objects: extra deployment dependency with no gain; objects are write-once.

## Consequences
- Integrity is checkable anywhere with `javelin fsck`.
- Crash safety follows from atomic renames plus ref CAS.
- Loose files mean many small files; packing is future work, recorded as a limitation.
