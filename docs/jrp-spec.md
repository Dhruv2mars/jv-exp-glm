# JRP v2 Specification

Status: normative. Version: 2. Date: 2026-09-09. Supersedes JRP v1 (ADR 0003). Implements ADR 0007.

JRP (Javelin Repository Protocol) is the JSON-over-HTTP contract between Javelin clients (CLI, SDK, web) and servers (javelind, the hosted data plane). This document defines the wire format, endpoints, limits, errors, CAS semantics, pagination, streaming, and idempotency rules. TypeScript types in `@javelin/protocol` (`packages/protocol/src/jrp.ts`) are a projection of this spec, not the spec itself. Where this document and the types disagree, this document wins.

Domain terms (state, World, layer, contribution, provenance, evidence) are defined in `docs/javelin-model.md`.

## 1. Conventions

- All routes are prefixed with `/jrp/v2`.
- Request and response bodies are UTF-8 JSON with `Content-Type: application/json`, except the raw blob endpoints (section 8).
- Object ids are content addresses: 64 lowercase hex characters (the SHA-256 of the object's canonical serialization). The type is `ObjectId`.
- Domain shapes (`Tree`, `State`, `ProvenanceRecord`, `EvidenceRecord`, `Contribution`, `LayerRef`, `Person`) are defined in `packages/protocol/src/model.ts` and are embedded in wire payloads as canonical JSON.

## 2. Versioning and negotiation

- `JRP_VERSION` is `2`.
- Every client request MUST carry the header `x-jrp-version: 2`. The health endpoints (`GET /jrp/v2/healthz`, `GET /jrp/v2/readyz`) MAY accept requests without the header.
- If the server does not support the requested version, it responds `409` with a version envelope and does not process the request:

```json
{ "error": { "code": "version_not_supported", "message": "unsupported JRP version", "supported": [2] } }
```

- A server MAY support several major versions. `supported` lists every major version it accepts.

## 3. Auth

Clients authenticate with a bearer token:

```
Authorization: Bearer <token>
```

On missing, malformed, or invalid credentials the server responds `401` with the standard error envelope and does not process the request. A valid token that lacks permission for the requested repository or operation yields `403`.

## 4. Errors

Every failure response uses one envelope:

```json
{ "error": { "code": "<code>", "message": "<human-readable>" } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed body, invalid id, or invalid parameter. |
| `unauthorized` | 401 | Missing, malformed, or invalid credentials. |
| `forbidden` | 403 | Authenticated, but not allowed. |
| `not_found` | 404 | Repository, object, or contribution does not exist. |
| `conflict` | 409 | A CAS expectation failed where the endpoint has no richer result, or a concurrent write conflict. |
| `version_not_supported` | 409 | The `x-jrp-version` value is not supported. Carries `supported`. |
| `payload_too_large` | 413 | Body or object exceeds a limit in section 5. |
| `internal` | 500 | Server fault. Clients may retry with backoff. |

These mappings also exist in code as `ERROR_HTTP_STATUS` in `packages/protocol/src/jrp.ts`.

## 5. Limits

| Constant | Value | Applies to |
|---|---|---|
| `MAX_BATCH_BYTES` | 33554432 (32 MiB) | Every JSON request body, and every JSON response body of the batch endpoints. |
| `MAX_OBJECT_BYTES` | 4194304 (4 MiB) | Decoded size of one blob inside a JSON batch. |
| `DEFAULT_PAGE` | 100 | Page size when a listing request omits `limit`. |
| `MAX_PAGE` | 1000 | Server-enforced upper bound on `limit`; the server clamps larger values. |

A request that would exceed `MAX_BATCH_BYTES` is rejected with `413 payload_too_large` before the server reads the full body. A blob larger than `MAX_OBJECT_BYTES` cannot travel in JSON at all; use the raw endpoints (section 8).

## 6. Wire object encoding

A wire object is one of:

- Blob: `{ "id": "<ObjectId>", "kind": "blob", "data": "<base64>" }`, where `data` is standard base64 (RFC 4648, with padding) of at most `MAX_OBJECT_BYTES` bytes.
- Structured kinds: `{ "id": "<ObjectId>", "kind": "tree" | "state" | "provenance" | "evidence" | "contribution", "object": { ... } }`, where `object` is the canonical JSON of the model shape.

A wire object has exactly one of `data` or `object`, matched to its `kind`. No other kind exists on the wire.

The pure helpers `encodeWireBlob`, `decodeWireBlob`, `assertObjectWithinLimits`, and `assertBatchWithinLimits` in `packages/protocol/src/jrp.ts` enforce these rules and throw `LimitExceededError` on violation. Servers map `LimitExceededError` to `413 payload_too_large`.

## 7. Endpoints

All examples are small and elided with `...` where a payload continues.

### 7.1 Create a repository

`POST /jrp/v2/repos`

```json
{ "name": "demo", "description": "first repo" }
```

Response `200`:

```json
{ "repo": { "name": "demo", "description": "first repo", "createdAt": "2026-09-09T00:00:00.000Z" } }
```

The name must be a non-empty URL path segment. Duplicate names yield `409 conflict`.

### 7.2 List repositories

`GET /jrp/v2/repos?cursor=<Cursor>`

Response `200`:

```json
{ "repos": [ { "name": "demo", "createdAt": "2026-09-09T00:00:00.000Z" } ], "nextCursor": "b2Zmc2V0OjE" }
```

`nextCursor` is absent on the last page.

### 7.3 Read heads

`GET /jrp/v2/repos/:repo/heads`

Response `200` (shape `HeadsView`):

```json
{
  "world": "ab...",
  "layers": [
    { "name": "agent-x", "base": "ab...", "head": "cd...", "updatedAt": "2026-09-09T00:00:00.000Z" }
  ]
}
```

`world` is `null` before the first publish. A layer head may be `null`.

### 7.4 Update heads (CAS)

`POST /jrp/v2/repos/:repo/heads/update`

```json
{
  "updates": [
    { "key": "world", "expected": "ab...", "next": "cd..." },
    { "key": "layer/agent-x", "expected": null, "next": "ef..." }
  ]
}
```

- `key` is `world` or `layer/<name>`.
- `expected` is the value the caller believes the head has; `null` means the head must not exist.
- `next` is the value to install; `null` deletes the head.

Response `200`, one result per update, in request order:

```json
{
  "results": [
    { "key": "world", "ok": true },
    { "key": "layer/agent-x", "ok": false, "reason": "cas-mismatch" }
  ]
}
```

**Atomicity.** Each key is one independent compare-and-swap. The server applies updates in request order and does not roll back earlier keys when a later key fails. Callers get all-or-nothing only by reading `results` and compensating; the protocol does not provide a cross-key transaction. A `409 conflict` at the endpoint level is reserved for server-side write conflicts, not for CAS failures, which are reported per key with HTTP `200`.

**Crash notes.** If the server crashes mid-request, some keys may be advanced and others not. Clients must treat heads as individually consistent only: re-read `GET heads` after an ambiguous failure, and never assume a batch advanced as a whole. Because `expected` pins the prior value, retrying the same batch is safe: keys that already advanced report `cas-mismatch` instead of applying twice.

### 7.5 Fetch objects in bulk

`POST /jrp/v2/repos/:repo/objects/batch-fetch`

```json
{ "ids": ["ab...", "cd..."] }
```

Response `200`:

```json
{ "objects": [ { "id": "ab...", "kind": "blob", "data": "aGVsbG8=" } ], "missing": ["cd..."] }
```

The request body and the response body are both bounded by `MAX_BATCH_BYTES`. `missing` lists every requested id the server does not store, so a response never needs a second round trip to learn what is absent.

### 7.6 Upload objects in bulk

`POST /jrp/v2/repos/:repo/objects/batch-upload`

```json
{ "objects": [ { "id": "ab...", "kind": "blob", "data": "aGVsbG8=" } ] }
```

Response `200`:

```json
{ "accepted": ["ab..."], "rejected": [ { "id": "cd...", "reason": "id does not match content" } ] }
```

The server validates each object by re-hashing its canonical serialization and comparing the result to `id`. A mismatched id, an unknown `kind`, or a blob over `MAX_OBJECT_BYTES` is rejected per object. An object over `MAX_BATCH_BYTES` in total, or a request body over it, yields `413 payload_too_large`.

### 7.7 State log

`POST /jrp/v2/repos/:repo/states/log`

```json
{ "start": "ab...", "limit": 50 }
```

Response `200`:

```json
{
  "entries": [
    { "id": "ab...", "parents": [], "message": "init", "author": { "name": "a", "email": "a@x", "time": "2026-09-09T00:00:00.000Z" } }
  ],
  "nextCursor": "cGF0aDoxMA"
}
```

`start` must be an existing state id (`404 not_found` otherwise). Entries walk parents newest first.

### 7.8 Provenance

Ingest: `POST /jrp/v2/repos/:repo/provenance`

```json
{ "record": { "kind": "provenance", "states": ["ab..."], "agent": { "name": "codex", "adapter": "codex" }, "startedAt": "2026-09-09T00:00:00.000Z" } }
```

Response `200`: `{ "id": "ef..." }`.

Query: `POST /jrp/v2/repos/:repo/provenance/query`

```json
{ "states": ["ab..."], "agent": "codex" }
```

Response `200`: `{ "records": [ ... ], "nextCursor": "..." }`. All filters are optional; `states` matches records that reference any of the given states.

### 7.9 Evidence

Ingest: `POST /jrp/v2/repos/:repo/evidence`

```json
{ "record": { "kind": "evidence", "state": "ab...", "rules": "ci@sha256:abc", "checks": [ { "check": "build", "status": "pass" } ], "at": "2026-09-09T00:00:00.000Z" } }
```

Response `200`: `{ "id": "ef..." }`.

Query: `POST /jrp/v2/repos/:repo/evidence/query`

```json
{ "state": "ab...", "rules": "ci@sha256:abc" }
```

Response `200`: `{ "records": [ ... ] }`. All evidence for one state is returned in full; this query is not paginated.

### 7.10 Contributions

Create: `POST /jrp/v2/repos/:repo/contributions`

```json
{ "contribution": { "kind": "contribution", "layer": "agent-x", "state": "cd...", "base": "ab...", "title": "Fix bug", "author": { "name": "a", "email": "a@x", "time": "2026-09-09T00:00:00.000Z" }, "createdAt": "2026-09-09T00:00:00.000Z" } }
```

Response `200`: `{ "id": "ef..." }`. A new contribution starts with status `open`.

List: `GET /jrp/v2/repos/:repo/contributions?status=open&cursor=<Cursor>`

```json
{ "contributions": [ { "id": "ef...", "kind": "contribution", "layer": "agent-x", "state": "cd...", "base": "ab...", "title": "Fix bug", "author": { "name": "a", "email": "a@x", "time": "2026-09-09T00:00:00.000Z" }, "createdAt": "2026-09-09T00:00:00.000Z", "status": "open" } ], "nextCursor": "..." }
```

`status` is optional; without it the server returns contributions in any status.

Change status (CAS): `POST /jrp/v2/repos/:repo/contributions/:id/status`

```json
{ "expected": "open", "next": { "status": "published", "worldState": "99..." } }
```

Response `200` on success: `{ "id": "ef...", "ok": true, "status": "published" }`. On failure:

```json
{ "id": "ef...", "ok": false, "reason": "cas-mismatch" }
```

with `reason` one of `cas-mismatch` (the status is not `expected`), `illegal-transition`, or `not-found`.

**Legal transitions.** The only legal transitions are `open → published` and `open → discarded`. `published` and `discarded` are terminal; a contribution never returns to `open`. A `published` update MUST carry `worldState` (the World state produced by publishing); a `discarded` update MUST NOT carry it. `note` is optional free text on either. The table lives in code as `CONTRIBUTION_TRANSITIONS`.

**Atomicity.** The status change and the recorded `worldState` are one metadata write. The caller is responsible for having advanced the World head (section 7.4) before or atomically with publishing; this endpoint records the decision, it does not perform the merge.

### 7.11 Search

`POST /jrp/v2/repos/:repo/search`

```json
{ "query": "parse tree", "kind": "code", "limit": 20 }
```

Response `200`:

```json
{ "hits": [ { "kind": "code", "blob": "ab...", "path": "src/parse.ts", "snippet": "...", "score": 0.93 } ], "nextCursor": "..." }
```

`kind` is `code`, `history`, or `provenance` and selects which index the server queries. Hit shapes differ per kind: `code` hits reference a blob and path, `history` hits reference a state, `provenance` hits reference a provenance record.

### 7.12 Health

- `GET /jrp/v2/healthz` → `{ "ok": true }`. Liveness only; no dependency checks.
- `GET /jrp/v2/readyz` → `{ "ok": true, "checks": { "store": true, "search": false } }`. One entry per dependency; `ok` is false if any check is false.

## 8. Raw blob transfer

Blobs larger than `MAX_OBJECT_BYTES` never travel inside JSON.

- Upload: `PUT /jrp/v2/repos/:repo/raw/:objectId` with `Content-Type: application/octet-stream` and a `Content-Length` header. The server streams the body to storage; it does not buffer the whole blob in memory.
- Download: `GET /jrp/v2/repos/:repo/raw/:objectId`. The server streams the response with the same content type. A missing object yields `404 not_found` with the standard error envelope.

The server verifies on upload that the SHA-256 of the streamed bytes equals `:objectId` and rejects mismatches with `400 bad_request`. Error responses use the JSON envelope even on these endpoints; success responses are the raw bytes. Clients SHOULD send the `x-jrp-version` header here as everywhere else.

## 9. Pagination

- Listings (`list repos`, `log`, `provenance/query`, `contributions`, `search`) take an optional `cursor` and an optional `limit`.
- `limit` defaults to `DEFAULT_PAGE` (100). The server clamps `limit` to `MAX_PAGE` (1000).
- A cursor is an opaque, server-produced string. Clients must not parse, construct, or expire-check one; they pass it back verbatim. Cursors are keyset-based, so pages stay stable when new records are appended between requests.
- `nextCursor` is absent on the last page. Its presence is the only continuation signal.
- Evidence queries are bounded by definition (one state) and are not paginated.

## 10. Idempotency

- `batch-upload` is idempotent by content address. Uploading an object the server already stores succeeds and reports it in `accepted`; the server does not create a duplicate.
- Provenance and evidence ingestion are idempotent the same way: the record id is its content address, so re-posting an identical record returns the same id and changes nothing.
- `heads/update` retries are safe because every key is guarded by `expected` (section 7.4). A retry after an ambiguous failure either applies once or reports `cas-mismatch`.
- Contribution status updates are CAS-guarded by `expected` and terminal by transition rules, so a retried `published` request reports `cas-mismatch` instead of re-publishing.

## 11. Non-goals

JRP v2 deliberately does not define:

- Wire compatibility with v1. Servers implement v2; v1 consumers migrate in the same wave as the VCS core (ADR 0007).
- A cross-key transaction over heads. Updates are per-key CAS only (section 7.4).
- Push rules, CI, or required checks. Publish policies are per-repository metadata enforced above this protocol (ADR 0004, `docs/javelin-model.md`).
- Merge computation over the wire. Clients compute merges; servers verify CAS and object completeness.
- A binary framing or codegen (protobuf, gRPC). JSON with bounds plus raw streaming is the chosen trade-off (ADR 0007).
- Git interoperability. The Git bridge maps branches and the mainline onto layers and World; JRP itself has no Git concepts.
- Object deletion or garbage collection. Content-addressed objects are immutable and append-only.
