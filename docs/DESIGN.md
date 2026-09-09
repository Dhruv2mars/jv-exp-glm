# javelin-cli design

This document freezes the architecture. It records what was decided, not what is being explored. Each section states the decision first, then the reasoning that binds it.

## Scope

javelin-cli is a local, standalone version control system. It is not an agent, not an orchestrator, not an IDE, not a package manager, and not a CI runner. It has no server, no account, and no Git interop. The CLI binary is the only product surface; there is no daemon with its own name or lifecycle.

## World

One project has one World: the complete codebase, seen by the user as the project folder. A World is never edited. Each publish creates the next immutable World version, and versions form a single ordered history with no branches and no divergence.

A World version record contains the code tree root, the parent version, the publishing layer, an optional context root, the publication timestamp, and integrity metadata. The version id is the hash of exactly that record, so identical code with different provenance yields different versions. Reverting never moves a pointer backward; it publishes a new version whose content matches an older one.

## Layers

Every task starts in a Layer. A Layer is an isolated workspace for one unit of work, owned by one agent; a human is always implicitly part of any Layer and needs no ownership ceremony. Human-only Layers carry code only. Agent Layers carry code plus the captured native trace.

A Layer stores only its changes: a base World version plus an overlay of created, modified, and deleted paths. Creating a Layer writes small metadata and materializes a workspace folder; it never copies the repository. The workspace folder is the working state, and it is what editors, compilers, and agents see. Sealing scans the workspace, writes the changed content as immutable objects, and advances the Layer's saved root through an atomic pointer swap. Seal runs at agent lifecycle boundaries and automatically before clone, stack, and publish.

Cloning a Layer copies one state-root pointer and materializes a fresh workspace. The clone shares all objects with its source, costs nothing proportional to the World, and never sees later edits to the source.

Nested Layers exist at the parent agent's discretion: a parent that wants a subagent to have independent code isolation creates a child Layer and stacks it back when the subagent finishes. Subagents that share the parent's Layer are one agent system; Javelin records their traces under the parent's context and does not coordinate their writes.

## Publish and stack: one composition engine

Publish adds one whole Layer to the current World and creates the next version. There is no staging, no partial publish, and no merge state. Acceptance is optimistic: the expensive work (seal, diff, candidate tree) happens outside any lock, and only the final World pointer update is serialized under a compare-and-swap. If another publish wins the race first, the check repeats against the new version.

Stack folds layers into one target Layer through the same engine as publish: derive what the source changed against its base, then apply exactly that onto the target. Independent changes compose regardless of order; identical changes deduplicate; declared ancestry (a parent Layer among the sources) applies first.

The engine never invents content. When both sides changed the same path it attempts a deterministic line-level three-way merge over the text bytes; anything else becomes a structured conflict. A failed operation returns an immutable diagnostic (paths, conflict types, both states) and leaves the target byte-for-byte unchanged. Resolution is ordinary editing inside the Layer, by the owner, followed by a retry.

Conflicts are structural, at the path and object level:

- same path requires different final content
- one result contains a path while another deletes it
- same path requires incompatible object kinds
- one path must simultaneously be a file and a directory
- portable path identities collide

Build and test failures are not VCS conflicts. Javelin reports why a composition is ambiguous; it does not judge the result.

A stale base is not by itself a conflict. Publish compares only the paths the Layer touched against the paths that changed since its base. Disjoint work publishes onto the newer World without a refresh; overlapping work rejects with the conflict plan above.

## Storage

Canonical state lives in `.javelin/` inside the project folder. Copying that folder captures everything. There is no machine-wide store and no database that owns accepted history.

Storage has two planes:

- An immutable, content-addressed object plane: file blobs, symlink records, trees, sealed Layer states, World versions, trace chunks, context roots, timeline events. Writing an existing id is a no-op; verifying an object means re-hashing it against its id.
- A mutable reference plane of tiny pointer files: the World head and each Layer's saved root. References update through temp-plus-rename inside a per-ref lock, with an expected generation for compare-and-swap. Locks are stolen when the holder dies, so a crash cannot strand the repository.

Object ids are self-describing: algorithm code, digest length, digest. BLAKE3-256 is the default; SHA-256 exists as an explicit profile. Every hash input is domain-separated and versioned (`JVL\0`, format major, domain tag, payload length, payload), so the same bytes under different domains never collide. Durable records encode in a canonical CBOR profile: definite lengths, shortest integer encodings, map keys sorted by encoded bytes, no floats, no tags.

Trees are the fundamental state. A tree is a sorted directory record whose unchanged subtrees are shared structurally between any two states, so publishing a small Layer writes only the changed objects and the tree nodes along their ancestor paths. Diffs are derived comparisons between states, never stored as truth; caches are disposable.

Durability has three levels. Working writes persist in the workspace folder. Sealed states are flushed and fsynced. Published versions get the strongest flush, including the parent directory. After an operation is acknowledged, process death or power loss returns either that state or an explicit error, never silent corruption; a torn append tail is truncated, and a payload that fails its id check is reported as corruption, never repaired by guessing.

## Agent context

Code and intent are tied together. An agent Layer binds its code root and its trace root in one sealed state, so a crash cannot save one without the other. Traces are the agent's native format, sanitized by the adapter, stored as content-addressed chunks that grow by appending; a new saved state costs only the new trace bytes. The normalized envelope (agent type, session id, subagent relationships, timestamps) is small metadata, not a translation of the trace.

Context is mandatory for agent work. A publish without a captured trace warns and, in an interactive session, asks; automation must pass `--allow-missing-context` explicitly, and the World version records the override. Human Layers have no context root and need no explanation.

## Filesystem rules

Content is exact bytes: no line-ending conversion, no encoding normalization, no ownership, timestamps, or extended attributes in identity. Preserved semantics are file contents, directory structure, the executable bit, symlink targets, deletions, and renames (derived, not stored).

Paths are portable by construction: relative, no dot segments, no platform separators inside names, and no collisions under a versioned comparison key (NFC normalization plus lowercase in format v1). The original spelling is stored.

`.javelinignore` governs the discovery of new unversioned paths only. It never removes tracked content; removing a versioned path requires an explicit deletion inside a Layer. `init` seeds the file from `.gitignore` when one exists.

## Reliability contract

Javelin never silently corrupts acknowledged state. Publish is atomic: a crash leaves the previous World version or the new one, never a mixture. A retried publish with a stable `--operation-id` returns the original result, and a crashed attempt that already accepted a version is adopted, not duplicated. Concurrent commands lock only the reference they mutate; Layer A autosaving never waits for Layer B. Garbage collection and compaction are future background work that must never block active Layers; nothing in the current design requires them for correctness.

## Performance posture

The initial target is one hundred concurrent Layers on one developer machine with correctness intact. The architectural rules that make that credible: no full World copy on Layer creation, no repository-wide lock, no full-tree scan for routine status, no eager refresh after publish, no context duplication, and no correctness downgrade under load. Layer creation and cloning are independent of World size in the canonical store; the v1 workspace projection is a full materialization and is documented as the fallback while a sparse macOS backend is evaluated through the frozen backend contract (create, open, flush, list changed paths, seal, clone, close, recover).
