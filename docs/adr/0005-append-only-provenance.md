# ADR 0005: Provenance and evidence are append-only references

Date: 2026-09-09. Status: accepted. Supersedes the v1 amend-and-ref-move mechanism.

## Context
v1 attached provenance/evidence by amending the commit and moving its ref. That rewrites the commit id, so anyone who already fetched the state sees diverged history, and evidence becomes unverifiable after attachment. The product thesis is attaching metadata to states; a mechanism that mutates states is wrong at the core.

## Decision
Provenance and evidence are standalone immutable objects that reference state ids:
- `ProvenanceRecord.states: ObjectId[]` — which states the run produced or affected.
- `EvidenceRecord` binds `state` + `rules` (identifier of the exact ruleset/revision) + `environment` + per-check results, so valid evidence can be reused safely against the same rules and environment.
- Attachment is writing a new object (and optionally an index entry). It never rewrites a state, never moves a head by itself.
- Run chains use `parentRun` referencing the parent provenance record id.

## Alternatives
- Fields on State (like v1's `Commit.provenance`): rejected — appends would mutate the state.
- A separate metadata database keyed by state id: rejected for now — objects keep provenance content-addressed, transferable with normal object sync, and GC-reachable via the same rules. An index for fast lookup is a derived view.

## Consequences
- The v2 `State` carries no provenance field; provenance created during a checkpoint references the state after creation, or is written first and referenced from the checkpoint message/index.
- Publishing policy (optional, per repo) evaluates evidence by walking provenance/evidence objects referencing the proposed state — reachability by reference, not history walk.
