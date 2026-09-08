# Roadmap

Vertical slices, each landing as a merged PR with real-flow tests. Status: pending / in-progress / merged.

| # | Slice | Scope | Status |
|---|---|---|---|
| 1 | Scaffold + contracts | workspace, docs, JRP types | merged |
| 2 | vcs-core | object store, refs, index, commit, log, diff, checkout, branches, 3-way merge, crash safety | merged |
| 3 | javelind + JRP server | HTTP protocol, auth, CAS ref updates, persistence, concurrency/crash tests | merged |
| 4 | CLI local + remote | full `javelin` command set against vcs-core and javelind | merged |
| 5 | Git bridge | import/export/mirror vs real git | merged |
| 6 | Provenance | run/agent records on commits, query API | merged |
| 7 | Search | trigram code search, history search, provenance search | merged |
| 8 | Agent adapters | generic/codex/claude-code session capture + committing with provenance | merged |
| 9 | Evidence/policy | optional push-time acceptance policy | merged |
| 10 | SDK | TypeScript JRP client | merged |
| 11 | Web forge | repo browser, search, provenance views; browser-verified | merged |
| 12 | Ops | backup/restore, deploy config, e2e suite | pending |
