# ADR 0001: TypeScript on Bun in a bun-workspaces monorepo

Date: 2026-09-09. Status: accepted.

## Context
The platform spans a VCS, a server, a CLI, a web app, an SDK, and tooling. They share types (JRP objects, provenance records, search schemas).

## Decision
One repository, bun workspaces, TypeScript everywhere, `bun test` as the single test runner.

## Alternatives
- Per-component repos with a published protocol package: version skew and release ceremony on day one.
- Rust for the VCS: performance headroom, but doubles the integration cost across seven components for a product whose stated goal is correct semantics, not throughput.

## Consequences
- Shared types are imported, not duplicated.
- Single `bun install` / `bun test` from the root.
- If the VCS ever needs native speed, the object store API is small enough to port behind the same interface.
