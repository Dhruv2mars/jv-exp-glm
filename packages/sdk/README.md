# @javelin/sdk

TypeScript client for the Javelin Repository Protocol (JRP).

```ts
import { JavelinClient, JrpError } from "@javelin/sdk";

const javelin = new JavelinClient({ baseUrl: "http://localhost:7420", token: process.env.JAVELIN_TOKEN });

const repo = await javelin.createRepo({ name: "demo" });
const refs = await javelin.listRefs("demo");

const { objects } = await javelin.fetchObjects("demo", [commitId]);
await javelin.uploadObjects("demo", objects);
await javelin.updateRefs("demo", [{ ref: "refs/heads/main", expectedOld: null, new: commitId }]);

const { commits } = await javelin.log("demo", "refs/heads/main", 50);
const { hits } = await javelin.search("demo", "parse", { kind: "code", limit: 10 });
```

Any non-2xx response throws `JrpError` with `code`, `message`, and `status`:

```ts
try {
  await javelin.listRefs("missing");
} catch (e) {
  if (e instanceof JrpError && e.code === "not_found") console.log(e.status); // 404
}
```

All request/response types are re-exported from `@javelin/protocol`. Pass `fetch` to inject a custom implementation (tests, proxies); defaults to `globalThis.fetch`.
