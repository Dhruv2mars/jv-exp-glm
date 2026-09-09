# Roadmap

Status after the semantics realignment (2026-09-09). Normative model: `docs/javelin-model.md`. The v1 slices are merged and superseded where the model changed; this roadmap tracks the v2 program in the owner's priority order.

## Priority order

1. **Correct Javelin VCS semantics.** World/Layers/Checkpoints/Contributions/Integrate/Publish as the internal model (`docs/javelin-model.md`). Replace commits/branches/refs/staging in the core, CLI, server, SDK, bridge, web.
2. **Core correctness.** Binary-safe data everywhere; line-level three-way integration with deletion correctness; append-only provenance/evidence (never rewrite a state id); real cross-process CAS on heads.
3. **Real JRP.** Binary-safe bounded wire format, batched/streamed transfer, pagination, request limits, version negotiation, normative spec (`docs/jrp-spec.md`).
4. **Complete macOS local + remote experience.** First-class macOS; standalone `jv` binary via GitHub Releases; CI covering typecheck, unit, e2e/smoke, release build. Windows explicitly deferred; Linux/container CI for the server.
5. **Git mirror + agent provenance/search.** Incremental mirror with explicit adoption/native authority modes; authenticated remote-agent provenance ingestion; async search as derived views.
6. **javelin.run architecture.** WorkOS identity, Convex control plane, Vercel frontend, javelind data plane (ADR 0008).
7. **Review/supervision.** Review that understands Contributions, Layer composition, provenance, and discarded attempts — not GitHub PRs over branches.
8. **OSS distribution/security/operations hardening.** MIT license, community files, quotas/abuse controls, observability completion, secure secret handling.
9. **Scale optimizations driven by benchmarks.** Reachability/GC, segments/packing only when numbers justify it, javelind caching/materialized views.

## Slice board (v2)

| Slice | Scope | Status |
|---|---|---|
| contracts | javelin-model.md, ADRs 0004-0009, protocol model.ts | merged |
| community | MIT LICENSE, CONTRIBUTING, CoC, SECURITY, templates, changelog | merged |
| vcs-core-v2 | states/trees/mode, layers/checkpoints, world head, contributions, diff3 merge + deletions, MetaStore CAS, GC reachability | merged |
| jrp-v2 | wire format, bounds, raw blob endpoints, pagination, spec doc | merged |
| javelind-v2 | head CAS via MetaStore seam, bounded/streaming endpoints, health/readiness, request IDs, structured logs | merged |
| cli-v2 | layer/checkpoint/contribute/integrate/refresh/publish verbs | merged |
| sdk-v2 | JRP v2 client | merged |
| provenance-v2 | append-only records, remote ingestion API | merged |
| bridge-v2 | git↔layers/world mapping, mirror modes, incremental sync | merged |
| policy-v2 | publish-boundary policy, evidence binding to state+rules+env | merged |
| search-v2 | async indexing over immutable history, derived views | merged |
| web-v2 | world/layers/contributions views | merged |
| e2e-v2 | end-to-end suite over the v2 model | merged |

## v1 archive

The v1 slices (protocol contracts, vcs-core, javelind+JRP, CLI, git bridge, provenance, search, agent adapters, evidence/policy, SDK, web forge, ops) are all merged (PRs #1-#14). They remain useful implementation references; where they disagree with docs/javelin-model.md, the model wins and the v2 slices above supersede them.

All v2 slices are merged. Core review follow-ups (lock token hardening, gc race fix, binary merge conflicts, adjacent-line merge) landed via PR #24. Next front: priority 4 (macOS `jv` binary + CI + release) and 5 (mirror authority modes made behavioral, remote-agent ingestion).
