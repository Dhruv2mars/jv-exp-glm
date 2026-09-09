# Contributing

Javelin is developer infrastructure for supervising coding agents: a native version control system and a forge. The code is TypeScript on Bun 1.3, organized as bun workspaces under `packages/` and `apps/`.

## Setup

```sh
bun install
```

## Test and typecheck

```sh
bun test            # full test suite
bun run typecheck   # tsc --noEmit over the workspace
```

Both must pass before you open a PR.

## Pull requests

- Open one branch per PR. Prefix commits with `feat:`, `fix:`, `test:`, `docs:`, or `chore:`.
- Tests must exercise real behavior. A test that claims runtime behavior (server, VCS, CLI, wire protocol) must run the real code path. Mock-only tests do not count.
- A change to semantics must update `docs/javelin-model.md`, which is normative, and add an architecture decision record under `docs/adr/`.

## Platform

macOS is the first-class development platform. Windows is out of scope for now.
