# Assumptions

Decisions made autonomously where the brief was open. Each can be overturned with an ADR.

1. **Language and runtime.** TypeScript on Bun 1.3 with bun workspaces. The team standard is bun, and one language across VCS, server, CLI, web, and SDK removes cross-language protocol drift.
2. **Storage.** Local VCS uses a content-addressed object store (sha256) of loose files with atomic writes. javelind stores per-repository object packs the same way plus a JSON/SQLite metadata sidecar. No database server dependency.
3. **JRP is HTTP + JSON.** Chunked/bundled object transfer as JSON frames over HTTP POST. Simpler than a custom TCP protocol and works through proxies; performance is not a stated goal.
4. **Ref updates use compare-and-swap** on expected old value, which gives concurrency safety without locks.
5. **Auth** is bearer tokens (static config for self-hosted javelind; issued tokens for the web). OAuth/SSO is future work and recorded as such.
6. **Git interop** shells out to the installed `git` binary using fast-export/fast-import streams, avoiding a git reimplementation or heavyweight dependency.
7. **Web app** is server-rendered HTML from Bun.serve with a small amount of client JS. Verified through real browser flows, not screenshots of templates.
8. **Provenance** records are JSON objects stored in the object store and referenced from commits, so provenance is versioned and transferable with normal push/fetch.
9. **Evidence/policy is optional**: pushes succeed without policy unless a repo declares one.
10. **Merge** is three-way with a simple recursive base selection; rename detection is out of scope and recorded as a limitation.
11. **Single-tenant local mode**: the CLI works fully offline against a `.javelin/` directory; remotes are additive.
12. **Codex/Claude Code adapters** integrate through their session/CLI file formats where they exist locally, and degrade to the generic adapter (manual capture) otherwise.
