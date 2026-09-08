# Javelin: Greenfield Build Brief

Status: Final implementation brief for a fresh build
Audience: Engineers joining with no prior Javelin context
Starting point: Empty repository
Goal: Build a complete, usable Javelin platform from scratch, including the native VCS, remote repository service, Git interoperability, agent integrations, provenance/search, and a hosted web product.

## Read this first

This is a greenfield build.
Do not inspect, copy, migrate, preserve compatibility with, or infer requirements from any existing Javelin repository. The current implementation is irrelevant to this exercise.
Treat this document as the source of truth for the intended product and semantics.
Make implementation decisions autonomously. If you want to change a semantic contract marked frozen, write an ADR explaining what you want to change, why the current contract is insufficient, alternatives considered, experiments or evidence, and consequences for compatibility and the rest of the system.
Implementation details marked open are intentionally yours to explore.
The goal is not a toy demo. The result should be usable by real developers.

## What Javelin is

Javelin is developer infrastructure for a world where humans supervise many coding agents working concurrently.
Two major products:

1. Javelin CLI / native VCS
2. Javelin Web / hosted forge, intended to eventually live at javelin.run

Use a monorepo from day one because the VCS, repository server, protocol, Git bridge, agent adapters, SDKs, web application, search, and deployment tooling share types and semantics.

Intended components:

- javelin-cli: native local VCS
- javelind: native repository server / data plane
- Javelin Web: hosted forge / control plane
- JRP: Javelin Repository Protocol
- Git bridge: import/export/mirror interoperability
- agent adapters: Codex, Claude Code, generic integrations
- provenance: agent/run context
- search: code + history + provenance search
- evidence/policy: optional verification and acceptance policy
- SDKs: programmatic integration
- hosting/ops: deployment, backup, restore, migration

## Build ground rules

- Real implementations and end-to-end flows. No placeholder pages, mock-only APIs, or TODO stubs presented as complete.
- Cover local versioning and recovery, remote repository operations, the Git bridge, the web forge, agent integrations, provenance and search, optional evidence/policy, SDK access, and operations.
- Make the full system runnable locally with documented commands and realistic integration tests. Exercise concurrency, crashes, authorization, persistence, backup/restore, and interoperability.
- Verify the web application's actual user flows.
- Do not claim a live deployment, registered domain, production security, or performance guarantees without evidence. Prepare concrete deployment work first and record what is missing.
