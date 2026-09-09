# The Javelin Model

Javelin is not a Git reimplementation. Javelin's internal model is built for a world where humans supervise many concurrent coding agents. Git is an interoperability format, handled only by the bridge — never Javelin's internal representation.

## The lifecycle

```
World Versions → Private Layers → Checkpoints → Contributions → Integrate / Refresh → Publish
```

### State
A **state** is an immutable, content-addressed snapshot of the entire file world (a tree). States are the only versioning primitive. A state records its parent states (lineage), author, and message. State ids never change and are never rewritten.

### World
The **World** is the accepted state. It advances only through Publish, and it advances atomically: the world head is a single mutable pointer updated by real compare-and-swap. World history is the chain of published states. Everything in World was accepted; nothing in World is tentative.

### Layer
A **Layer** is an isolated line of tentative work, forked from a World state (its **base**). Agents and humans work inside Layers; tentative work is never in World. A layer has a name, a base, and a head. Discarding a layer throws away the tentative line without touching World. Sibling layers are independent by construction — no shared mutable branch state.

### Checkpoint
A **checkpoint** is a preserved state on a layer's chain: a snapshot of the working tree captured with a message (and provenance, when an agent produced it). Layer head = last checkpoint. Checkpoints make tentative work durable and reviewable without accepting it.

### Contribution
A **contribution** is a proposal to publish a layer's head into World. It is an immutable object (layer, proposed state, base world state, title, author) plus an append-only status log: `open → published` or `open → discarded`. A discarded attempt remains visible — discarded work is provenance, not garbage.

### Integrate / Refresh
Integration is three-way at the line level, with correct deletion behavior:

- **Refresh** brings World changes into a layer. Merge base = the layer's base World state; ours = layer head; theirs = current World head. Two agents editing different lines of the same file must not conflict.
- **Sibling integration** composes layers: B and C integrate into A (merge base = common ancestor of the state chains) before A is proposed.

### Publish
**Publish** accepts a contribution into World: integrate the layer head with the current World head, then CAS-advance the World head from the expected current value to the merged state. If the expected value moved, the publish fails and the caller refreshes and retries. Publish enforces VCS correctness (fast-forward integrity, CAS, object completeness). Required tests, review, security, or evidence are optional, per-repository policies — Publish is not CI.

### Provenance and evidence
Provenance explains how a state came to be; the repository state proves what changed. Both are **append-only objects that reference immutable state ids**. Attaching provenance or evidence never rewrites a state id. Evidence is bound to the exact state, the rules it was produced under, and the environment, so valid evidence can be reused safely.

### Mutable metadata
Only a tiny, strongly-consistent set of things is mutable: the World head, layer heads, and contribution status. Everything else — objects, states, trees, provenance, evidence — is immutable. Locally these mutable pointers live under `.javelin/meta/` and are updated by a cross-process compare-and-swap protocol. On the hosted data plane the same interface is served by durable, strongly-consistent metadata; javelind nodes are replaceable compute and cache, never the sole holder of irreplaceable state.

### Git's place
Git import/export is a bridge concern: a Git branch maps to a Javelin layer, the Git mainline maps to World. Two modes exist — adoption mode (GitHub is authority, Javelin mirrors + adds Layers/provenance) and native mode (Javelin is authority, Git is a compatibility mirror). Both are never silently authoritative at once.
