# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Javelin has no releases yet. Everything listed here is merged on main. The v2 program in `docs/roadmap.md` tracks work in progress and pending; entries below summarize what exists today.

### Added

- JRP (Javelin Repository Protocol) shared types (`packages/protocol`)
- Native local VCS: object store, refs, index, merge (`packages/vcs`)
- TypeScript client for JRP (`packages/sdk`)
- `javelin` command line interface (`apps/cli`)
- `javelind` repository server and data plane (`apps/javelind`)
- Hosted forge web application (`apps/web`)
- Git import/export/mirror interoperability (`packages/git-bridge`)
- Agent and run provenance records (`packages/provenance`)
- Code, history, and provenance search (`packages/search`)
- Evidence and acceptance policy (`packages/policy`)
- Backup and restore tooling for javelind roots (`ops/`)
- Javelin semantic model v2 contracts: World, Layers, Checkpoints, Contributions, with architecture decision records (`docs/javelin-model.md`, `docs/adr/`, `packages/protocol`)
- OSS community files: MIT LICENSE, CONTRIBUTING, Code of Conduct, Security policy, issue and pull request templates, this changelog
