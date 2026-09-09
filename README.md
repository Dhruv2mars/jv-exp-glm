# javelin-cli

javelin-cli is a version control system for a world where coding agents do most of the work. It is a clean-sheet replacement for Git, not a wrapper around it. It has no branches, no commits, no staging area, and no server. One binary owns the whole flow.

The design came out of a long exploration of what breaks when a hundred agents work on one codebase: Git worktrees copy repositories, index locks serialize agents, and commit history records what changed but never why. javelin-cli stores states, keeps every task isolated, and captures the agent trace next to the code it produced.

## The model

```
World    the complete codebase, one per project.
         A sequence of immutable versions, v1, v2, v3, ...
         Never edited directly.

Layer    the only place code changes.
         An isolated workspace for one task, owned by one agent or one human.
         Stores only its changes against a base World version.
         Autosaves continuously; cloning is a pointer copy.

Publish  adds one complete Layer to the World.
         Creates the next immutable World version atomically.
         Rejects with structured conflicts when changes overlap.

Context  agent work carries its native trace, sealed together with the code.
         Human work carries no context. Both are just Layers.
```

There is no staging area and no partial publish. To ship part of a layer, clone it, delete what stays behind, and publish the clone. To combine work, stack layers into one and publish that.

## Quickstart

You need [Bun](https://bun.sh). Every command below was run against this commit.

First, version an existing folder:

```sh
bun run src/cli/main.ts init
```

This captures the current files as World v1, seeds `.javelinignore` from `.gitignore` when one exists, and creates `.javelin/` for all internal state.

Create a layer and work in it:

```sh
bun run src/cli/main.ts layer create fix-parser
bun run src/cli/main.ts layer open fix-parser
# prints .javelin/workspaces/fix-parser - edit files there
```

An agent session records its native trace next to the code:

```sh
bun run src/cli/main.ts session start --layer fix-parser --agent codex --session s-1
bun run src/cli/main.ts session trace --session s-1 --file /path/to/native-trace.jsonl
bun run src/cli/main.ts session end --session s-1
```

Publish the layer to create the next World version:

```sh
bun run src/cli/main.ts publish fix-parser
# published world v2 (blake3:...)
```

Inspect and verify:

```sh
bun run src/cli/main.ts history
bun run src/cli/main.ts show world 2
bun run src/cli/main.ts verify --full
```

Automation should append `--json` to every command. Output is a versioned envelope with stable error codes, and mutating commands accept `--operation-id` so a retried publish cannot create two versions.

## Design

[docs/DESIGN.md](docs/DESIGN.md) explains the frozen architecture: World versions, Layer storage, the composition engine shared by stack and publish, conflict semantics, agent context, and the reliability contract.

## Development

```sh
bun install
bun test
bun run typecheck
```

The test suite covers every core module, drives the real binary end to end against real folders, and asserts the scale invariants: layer creation adds zero objects to the store, and publish cost follows the changed paths, not the World size.

## Status

javelin-cli is the first stage of the Javelin project. The workspace projection that materializes layers is a documented fallback (full clone on create) while the sparse macOS backend is benchmarked; the canonical storage is overlay-only either way. The second stage, Javelin hosting, is out of scope here.
