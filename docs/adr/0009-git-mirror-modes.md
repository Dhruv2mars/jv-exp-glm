# ADR 0009: Git interoperability modes

Date: 2026-09-09. Status: accepted.

## Context
Git stays an interoperability format, never Javelin's internal model (ADR 0004). Real teams live on GitHub today, so Javelin needs both a way in and a way out, and it must be explicit which side is authoritative.

## Decision
Two explicit modes, never silently mixed:
- **Adoption mode.** GitHub is authority. Javelin is a mirror plus Layers/provenance: `git mainline ↔ World`, `git branches ↔ layers`. Pulls from Git update the mirror and World; local Layer work can be exported back as branches/PRs, but acceptance authority remains on GitHub.
- **Native mode.** Javelin is authority. World advances by Publish; Git is a compatibility mirror updated on publish for tooling that reads git.
The bridge export records which mode produced it (mirror metadata), and an incremental mirror (not whole-repo re-import) is the target for both directions.

## Alternatives
- Two-way automatic sync without an authority concept: rejected — silent divergence is the failure mode to design against.

## Consequences
- The v1 import/export becomes the baseline; incremental mirror sync and mode metadata are follow-up bridge units.
- Layer semantics map cleanly: a git branch is one layer; the git mainline is World.
