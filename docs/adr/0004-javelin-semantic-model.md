# ADR 0004: The Javelin semantic model replaces the Git-shaped VCS internals

Date: 2026-09-09. Status: accepted. Amends ADR 0002.

## Context
The experimental VCS reproduced Git's shape: commits, branches, refs/heads, staging, checkout, merge. The settled Javelin model is different: World Versions → Private Layers → Checkpoints → Contributions → Integrate/Refresh → Publish. Tentative work must be structurally isolated from accepted state; acceptance must be an atomic, reviewable transition. Keeping Git's model internally would lock wrong semantics into every consumer.

## Decision
Adopt docs/javelin-model.md as the normative model. Concretely:
- `State` replaces `Commit` (immutable full-tree snapshot, lineage via parents).
- Mutable pointers shrink to: world head, layer heads, contribution status. All other primitives are immutable objects.
- Layers replace branches; checkpoints replace commits-as-history; contributions replace PRs-over-branches; Publish (CAS on world head) replaces push/merge-to-main.
- `TreeEntry` gains `mode` (file/exec/symlink), deleting the git-bridge exec-bit sidecar.
- The staging index is deleted; the working tree belongs to the checked-out layer, and checkpointing captures it.
- Provenance and evidence become append-only objects referencing state ids (see ADR 0005).
- Git remains interop-only via the bridge (see ADR 0009).

No compatibility with the v1 experimental API is required; consumers migrate in the same wave.

## Alternatives
- Keep Git internals and add layers on top: rejected, duplication of two histories with lossy mapping.
- Layer state as diff chains instead of full snapshots: rejected for v2; snapshots make every state independently materializable and CAS-validatable. Delta optimization is future work driven by benchmarks.

## Consequences
- The VCS core, server, CLI, web, SDK, and bridge change in one coordinated wave.
- Git-shaped CLI commands disappear; layer/checkpoint/contribute/publish verbs replace them.
- v1 protocol types (`Commit`, `RefUpdate`, branch push semantics) are deleted once callers migrate.
