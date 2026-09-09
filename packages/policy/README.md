# @javelin/policy

Publish-boundary policy for Javelin repositories.

Publish is not CI. `Repository.publish` enforces VCS correctness only: fast-forward integrity, compare-and-swap, object completeness. Required checks are an optional, per-repository policy that callers evaluate at the publish boundary. With no policy, publish succeeds on VCS correctness alone.

## Policy shape

The policy is JSON stored in repo meta under the key `policy`:

```json
{
  "requireEvidence": [
    { "check": "build" },
    { "check": "lint", "rules": "lint-rules@1" }
  ],
  "requiredContribution": true
}
```

- `requireEvidence` lists checks that each need a passing `EvidenceRecord` on the proposed state. When an entry pins `rules`, only evidence produced under that exact ruleset counts.
- `requiredContribution` requires the publish to go through an open contribution whose proposed state is still the layer head.
- Absent policy or `{}` means no requirements.

`setPolicy` validates the shape and writes through a MetaStore compare-and-swap; `setPolicy(repo, null)` removes the policy. `getPolicy` returns `null` when absent and throws `PolicyError` when the stored value is malformed.

## Publish flow

1. Build the change in a layer and checkpoint it.
2. Open a contribution with `Repository.contribute`.
3. Run the checks your policy names and record each result with `recordCheck`.
4. Call `evaluatePublish(repo, contributionId)`. It returns `{ ok, violations: [{ check, detail }] }`.
5. When `ok` is true, call `Repository.publish`.

`evaluatePublish` reads only evidence records that reference the contribution's proposed state, through `Repository.evidenceFor`. It never walks state history. The `requiredContribution` check verifies the contribution is open and that its proposed state still equals the layer head.

## Evidence binding and reuse

An `EvidenceRecord` binds `state`, `rules`, `environment`, and per-check results (docs/adr/0005). `recordCheck(repo, { state, rules, environment, checks })` writes one through `Repository.recordEvidence`.

Evidence is reusable when the state, the rules, and the environment are all unchanged. New state content, a new ruleset revision, or a new environment invalidates reuse: record fresh evidence for the new binding. Evidence on a different state never satisfies a check.
