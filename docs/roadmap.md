# Roadmap

Vertical slices, each landing as a merged PR with real-flow tests. Status: pending / in-progress / merged.

| # | Slice | Scope | Status |
|---|---|---|---|
| 1 | Scaffold + contracts | workspace, docs, JRP types | in-progress |
| 2 | vcs-core | object store, refs, index, commit, log, diff, checkout, branches, 3-way merge, crash safety | pending |
| 3 | javelind + JRP server | HTTP protocol, auth, CAS ref updates, persistence, concurrency/crash tests | pending |
| 4 | CLI local + remote | full `javelin` command set against vcs-core and javelind | pending |
| 5 | Git bridge | import/export/mirror vs real git | pending |
| 6 | Provenance | run/agent records on commits, query API | pending |
| 7 | Search | trigram code search, history search, provenance search | pending |
| 8 | Agent adapters | generic/codex/claude-code session capture + committing with provenance | pending |
| 9 | Evidence/policy | optional push-time acceptance policy | pending |
| 10 | SDK | TypeScript JRP client | pending |
| 11 | Web forge | repo browser, search, provenance views; browser-verified | pending |
| 12 | Ops | backup/restore, deploy config, e2e suite | pending |
