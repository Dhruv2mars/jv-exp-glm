# @javelin/git-bridge

Git interoperability for Javelin v2 (docs/adr/0004, docs/adr/0009). Git is an
interop format, never the internal model. The bridge maps a real git repo into
the Javelin model and back.

## Mapping

| Git | Javelin v2 |
| --- | --- |
| Mainline (`refs/heads/<HEAD branch>`, usually `main`) | World chain: every mainline commit becomes a state; the chain of states ends as the World head, set through the vcs meta CAS (`world` metadata key) |
| Other branches (`refs/heads/*`) | One layer per branch, layer name = branch name. The layer base is the World state at the branch point (`git merge-base` of branch tip and mainline tip); the layer head is the branch tip state |
| Annotated tags | Bridge metadata only (`name -> stateId` in the report and `.javelin/bridge-map.json`). Javelin v2 has no tag object; tags are not re-exported |
| File modes | Direct: `100644 -> "file"`, `100755 -> "exec"`, `120000 -> "symlink"` (symlink target stored as the blob content; export recreates the link) |
| Commit metadata | `author` maps to the state author; the v2 `State` shape has a single author and no committer, so export writes the author as both git author and committer |

Branching structure is preserved: a git merge commit becomes a state with the
mapped parent states in the same order, so the DAG shape survives round trips.

## Incremental import

`importFromGit` keeps a persistent identity map at `<jvlRepo>/.javelin/bridge-map.json`
(`git-commit-sha -> javelin-state-id`, plus tag metadata). Commits already in the map are
skipped, so importing a git repo that gained new commits imports only the new commits,
advances the World head and layer heads, and a re-import with nothing new is a no-op.

## Mirror mode marker

Per ADR 0009 the bridge records which side is authoritative in
`<jvlRepo>/.javelin/bridge.json` as `{ mode, authority, at }`. Import writes
`adoption` / `github`; export writes `native` / `javelin`. Both accept an
explicit `mode` option. The marker is a record, not behavior.

## Export

`exportToGit` writes the World chain plus every layer head into a fresh or
existing git repo via `git fast-import`: World head -> `refs/heads/main`
(HEAD is pointed there), layer heads -> `refs/heads/<layer>`. Merge parents,
authors, message contents, exec bits, and symlinks are recreated. Tags are not
exported.

## Usage

```ts
import { importFromGit, exportToGit } from "@javelin/git-bridge";

await importFromGit("./upstream-git", "./repo");           // git -> Javelin
await exportToGit("./repo", "./mirror-git");               // Javelin -> git
```

Both require the `git` binary on PATH.

## Scoped typecheck

`bunx tsc -p packages/git-bridge/tsconfig.json --noEmit` (the package tsconfig
extends the root config with `include: ["src"]`).
