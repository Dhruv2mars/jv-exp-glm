# @javelin/search

Code, history, and provenance search over a Javelin repository.

- `indexCommit(repo, commitId)` builds a per-commit code index persisted at
  `.javelin/search/<commitId>.json` inside the repository root. The file holds
  the commit's flat path-to-blob map plus a lowercase trigram-to-paths map.
  Indexing is deterministic and idempotent.
- `searchCode(repo, query, limit?, commitId?)` searches an indexed commit
  (defaults to HEAD, then the most recently indexed commit). Trigram candidates
  are verified against real blob contents, so stale indexes cannot yield false
  positives. Queries shorter than 3 characters scan all files.
- `searchHistory(repo, query, limit?)` matches commit messages by regex or
  case-insensitive substring (invalid regex falls back to substring).
- `searchProvenance(repo, query, limit?)` matches `ProvenanceRecord` fields
  (agent name, model, summary). Records are read directly from the object store
  via `@javelin/vcs`; this package does not depend on `@javelin/provenance`.

Hits follow `SearchHit` from `@javelin/protocol`, ranked score-descending.
