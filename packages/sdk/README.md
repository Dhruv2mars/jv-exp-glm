# @javelin/sdk

TypeScript client for the Javelin Repository Protocol v2 (JRP). The wire contract is specified in `docs/jrp-spec.md`; all types are re-exported from `@javelin/protocol`.

```ts
import { JavelinClient } from "@javelin/sdk";

const javelin = new JavelinClient({ baseUrl: "http://localhost:7420", token: process.env.JAVELIN_TOKEN });

await javelin.createRepo({ name: "demo" });

const { objects, missing } = await javelin.batchFetch("demo", [treeId, stateId]);
const { accepted } = await javelin.batchUpload("demo", objects);
```

## Publishing with the heads CAS loop

Heads are mutable pointers updated by compare-and-swap. Each key (`world` or `layer/<name>`) is an independent CAS: `expected` pins the prior value, and a lost race reports `cas-mismatch` instead of applying. Re-read and retry:

```ts
import { objectId } from "@javelin/sdk";

async function publish(javelin: JavelinClient, repo: string, stateId: string) {
  const next = objectId(stateId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const heads = await javelin.getHeads(repo);
    const [result] = await javelin.updateHeads(repo, [{ key: "world", expected: heads.world, next }]);
    if (result?.ok) return next;
  }
  throw new Error("publish failed: world head kept moving");
}
```

A batch applies in request order without rollback. After an ambiguous failure, re-read `getHeads` and retry the same batch; keys that already advanced report `cas-mismatch` instead of applying twice.

## Raw blobs

Blobs larger than `MAX_OBJECT_BYTES` (4 MiB) never travel inside JSON. Raw endpoints take the bytes and their SHA-256 id directly:

```ts
import { objectId, JrpError } from "@javelin/sdk";

const bytes = new Uint8Array([0x00, 0xff, 0x7f]);
const id = objectId(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));

await javelin.putRawBlob("demo", id, bytes);
const stored = await javelin.getRawBlob("demo", id);
```

`batchUpload` enforces `MAX_OBJECT_BYTES` per blob and `MAX_BATCH_BYTES` (32 MiB) per request client-side and throws `LimitExceededError` before anything is sent.

## Pagination

Listings return an opaque `nextCursor`; its absence marks the last page. Cursors are branded (`Cursor`) so they can only flow back into cursor parameters:

```ts
let page = await javelin.listContributions("demo", { status: "open" });
for (const c of page.contributions) console.log(c.id, c.status);
if (page.nextCursor !== undefined) {
  page = await javelin.listContributions("demo", { status: "open", cursor: page.nextCursor });
}
```

Paginated methods: `listRepos`, `statesLog`, `queryProvenance`, `listContributions`, `search`.

## Errors

Any JRP error response throws `JrpError` with the envelope's `code`, `message`, the HTTP `status`, and on `version_not_supported` the `supported` versions:

```ts
try {
  await javelin.getHeads("missing");
} catch (e) {
  if (e instanceof JrpError && e.code === "not_found") console.log(e.status); // 404
}
```

A response that is not a valid JRP envelope (missing top-level fields, malformed error body) throws `JrpProtocolError`. Envelope validation is shallow for now: expected top-level fields must be present, their inner shapes are trusted.

Pass `fetch` in the options to inject a custom implementation (tests, proxies); it defaults to `globalThis.fetch`.
