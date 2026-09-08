# Javelin

Javelin is developer infrastructure for a world where humans supervise many coding agents working concurrently. It has two products: the Javelin CLI with a native version control system, and Javelin Web, a hosted forge.

## Components

| Path | Component |
|---|---|
| `packages/protocol` | JRP (Javelin Repository Protocol) shared types |
| `packages/vcs` | Native local VCS: object store, refs, index, merge |
| `packages/sdk` | TypeScript client for JRP |
| `apps/cli` | `javelin` command line interface |
| `apps/javelind` | Native repository server / data plane |
| `apps/web` | Hosted forge web application |
| `packages/git-bridge` | Git import/export/mirror interoperability |
| `packages/provenance` | Agent/run provenance records |
| `packages/search` | Code, history, and provenance search |
| `packages/policy` | Evidence and acceptance policy |

## Quickstart

```sh
bun install
bun test        # run the full test suite
bun run build   # build all packages
```

## Documentation

- `docs/brief.md` — the product brief
- `docs/roadmap.md` — slices and status
- `docs/assumptions.md` — assumptions made during the build
- `docs/blockers.md` — open blockers needing human input
- `docs/adr/` — architecture decision records
