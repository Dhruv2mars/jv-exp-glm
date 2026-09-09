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
| `packages/provenance` | Append-only agent/run provenance records |
| `packages/search` | Code, history, and provenance search |
| `packages/policy` | Evidence and acceptance policy |

## Quickstart

```sh
bun install
bun test        # run the full test suite (195 tests)
bun run typecheck
```

Javelin is built around one lifecycle: World versions (accepted state) → private Layers (tentative work) → Checkpoints (preserved layer states) → Contributions (proposals) → Integrate/Refresh → Publish (atomic acceptance into World). See docs/javelin-model.md.

Local repository:

```sh
bun run apps/cli/src/main.ts init my-repo
cd my-repo
bun run ../apps/cli/src/main.ts layer new my-work
echo "hello" > hello.txt
bun run ../apps/cli/src/main.ts checkpoint -m "first checkpoint"
bun run ../apps/cli/src/main.ts contribute -t "my first change"
bun run ../apps/cli/src/main.ts publish <contribution-id-from-contribute>
```

Remote (self-host, bearer-token dev mode per docs/operations.md):

```sh
bun run apps/javelind/src/main.ts --port 8080 --root ./data --token devtoken
bun run apps/web/src/main.ts --port 3000 --javelind http://localhost:8080 --token devtoken
# in a repository:
bun run apps/cli/src/main.ts remote add origin http://localhost:8080/my-repo --token devtoken
bun run apps/cli/src/main.ts push          # sync objects and heads
bun run apps/cli/src/main.ts clone http://localhost:8080/my-repo my-clone
```

Git import/export lives in the bridge (`packages/git-bridge`); Git is an interoperability format, never Javelin's internal model.

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
