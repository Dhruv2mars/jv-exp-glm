# ADR 0003: JRP is HTTP + JSON with CAS ref updates

Date: 2026-09-09. Status: accepted.

## Context
The CLI, SDK, web app, and agent adapters all need repository operations against javelind.

## Decision
JRP is a JSON-over-HTTP protocol. Core endpoints: repository create/list, ref list, batch object fetch by id, batch object upload, ref update (with expected-old-value CAS), log/query, search, provenance query. Auth is a bearer token.

## Alternatives
- A custom TCP protocol with a binary frame format: faster, but harder to debug, proxy, and client-bind.
- gRPC: codegen machinery for one internal protocol.

## Consequences
- The SDK is a thin fetch wrapper; the web app speaks the same protocol.
- Large pushes are bundled object lists; streaming/chunking is future work.
