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

Start the repository server and the web app:

```sh
bun run apps/javelind/src/main.ts --port 8080 --root ./javelind-data
bun run apps/web/src/main.ts --javelind http://localhost:8080 --port 3000
```

Use the CLI against the running server (set `JAVELIN_TOKEN` if javelind was started with `JAVELIND_TOKEN`):

```sh
bun run apps/cli/src/main.ts clone http://localhost:8080/myrepo myrepo
bun run apps/cli/src/main.ts add .   # from inside myrepo
bun run apps/cli/src/main.ts commit -m "first change"
bun run apps/cli/src/main.ts push origin
```

Back up and restore a javelind root:

```sh
bun run ops/backup.ts --root ./javelind-data --archive ./backups
bun run ops/restore.ts --archive ./backups/<timestamp> --root ./restored-data
```

See `docs/operations.md` for token auth, Docker Compose deployment, and operational limitations.

## Documentation

- `docs/brief.md` — the product brief
- `docs/roadmap.md` — slices and status
- `docs/assumptions.md` — assumptions made during the build
- `docs/blockers.md` — open blockers needing human input
- `docs/adr/` — architecture decision records
