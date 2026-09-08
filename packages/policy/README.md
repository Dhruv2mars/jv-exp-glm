# @javelin/policy

Evidence and acceptance policy for Javelin repositories.

A repository may declare a policy in its javelind `meta.json` (same file that holds `name`, `createdAt`, `defaultBranch`):

```json
{ "policy": { "requireEvidence": ["ci-green", "lint-clean"] } }
```

Pushes succeed without a policy unless the repo declares one. A declared policy lists evidence check names that must each have a passing `EvidenceRecord` reachable from the pushed head commit's history.

## API

- `evaluatePolicy(repo, newHead, policy)` walks commits from `newHead` (BFS over parents), reads every object referenced by each commit's `provenance` id list, and collects `EvidenceRecord`s. Each required check needs a `pass` record; a reachable `fail` record for a required check is itself a violation. Returns `{ ok, violations: [{ check, detail }] }`.
- `attachEvidence(repo, commitId, record)` writes the record into the object store and appends its id to the commit's `provenance` list by amending the commit (same tree/parents/message) and CAS fast-forwarding the ref that points at it. This mirrors the mechanism in `@javelin/provenance` and is reimplemented here so this package does not depend on it.
- `setPolicy(repoRoot, policy)` / `getPolicy(repoRoot)` read and write the `policy` field of `<repoRoot>/.javelin/meta.json`, preserving other fields and writing atomically. `setPolicy(root, null)` removes the policy.
