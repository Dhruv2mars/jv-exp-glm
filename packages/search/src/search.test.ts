import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectId } from "@javelin/protocol";
import { Repository } from "@javelin/vcs";
import { hasIndex, indexCommit, searchCode } from "./code";
import { InvalidCursorError } from "./cursor";
import { searchHistory } from "./history";
import { searchProvenance } from "./provenance";

const encoder = new TextEncoder();

interface Fixture {
  repo: Repository;
  root: string;
  head: ObjectId;
  history: ObjectId[];
  cleanup(): Promise<void>;
}

async function buildRepo(filesByStep: Record<string, Uint8Array | string>[], messages: string[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "javelin-search-"));
  const repo = await Repository.init(root);
  await repo.layerNew("agent-x");
  const history: ObjectId[] = [];
  for (let i = 0; i < messages.length; i++) {
    for (const [path, content] of Object.entries(filesByStep[i] ?? {})) {
      await Bun.write(join(root, path), content);
    }
    const { stateId } = await repo.checkpoint({
      message: messages[i]!,
      author: { name: "a", email: "a@x" },
      layer: "agent-x",
    });
    history.push(stateId);
  }
  return {
    repo,
    root,
    head: history[history.length - 1]!,
    history,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const fixtures: Fixture[] = [];
afterAll(async () => {
  for (const f of fixtures) await f.cleanup();
});

describe("search v2", () => {
  test("indexCommit indexes a state tree; searchCode returns path and snippet", async () => {
    const f = await buildRepo([{ "src/parse.ts": "export function parseTree(x: number) { return x; }\n" }], ["add parser"]);
    fixtures.push(f);
    await indexCommit(f.repo, f.head);
    expect(await hasIndex(f.repo, f.head)).toBe(true);

    const page = await searchCode(f.repo, "parseTree", { stateId: f.head });
    expect(page.hits).toHaveLength(1);
    const hit = page.hits[0]!;
    if (hit.kind !== "code") throw new Error("expected code hit");
    expect(hit.path).toBe("src/parse.ts");
    expect(hit.snippet).toContain("parseTree");
    expect(hit.score).toBeGreaterThan(0);
    expect(page.nextCursor).toBeUndefined();
  });

  test("searchCode verifies against blob bytes and is binary-safe", async () => {
    const bytes = new Uint8Array([
      0x00, 0xff, 0x80, 0x81, 0x0a, ...encoder.encode("alpha BINARYNEEDLE beta\n"), 0xfe, 0xff,
    ]);
    const f = await buildRepo([{ "blob.bin": bytes }], ["binary blob"]);
    fixtures.push(f);
    await indexCommit(f.repo, f.head);

    const page = await searchCode(f.repo, "BINARYNEEDLE", { stateId: f.head });
    expect(page.hits).toHaveLength(1);
    const hit = page.hits[0]!;
    if (hit.kind !== "code") throw new Error("expected code hit");
    expect(hit.path).toBe("blob.bin");
    expect(hit.snippet).toContain("BINARYNEEDLE");

    expect((await searchCode(f.repo, "NOTPRESENT", { stateId: f.head })).hits).toEqual([]);
  });

  test("indexing the same state twice is byte-identical", async () => {
    const f = await buildRepo([{ "a.txt": "idempotent content\n" }], ["first"]);
    fixtures.push(f);
    await indexCommit(f.repo, f.head);
    const first = await readFile(join(f.root, ".javelin", "search", `${f.head}.json`), "utf8");
    await indexCommit(f.repo, f.head);
    const second = await readFile(join(f.root, ".javelin", "search", `${f.head}.json`), "utf8");
    expect(second).toBe(first);
  });

  test("searchCode paginates with stable keyset cursors", async () => {
    const files: Record<string, string> = {};
    for (const name of ["a", "b", "c"]) files[`${name}.txt`] = "paginated data here\n";
    const f = await buildRepo([files], ["page me"]);
    fixtures.push(f);
    await indexCommit(f.repo, f.head);

    const paths: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await searchCode(f.repo, "paginated", { stateId: f.head, cursor, limit: 1 });
      expect(result.hits.length).toBeLessThanOrEqual(1);
      for (const hit of result.hits) {
        if (hit.kind === "code") paths.push(hit.path);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(paths.sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("invalid cursor is rejected", async () => {
    const f = await buildRepo([{ "x.txt": "needle\n" }], ["m"]);
    fixtures.push(f);
    await expect(searchCode(f.repo, "needle", { stateId: f.head, cursor: "!!!" })).rejects.toThrow(InvalidCursorError);
  });

  test("searchHistory matches state messages and paginates", async () => {
    const f = await buildRepo([{}, {}, {}], ["checkpoint alpha", "checkpoint beta", "unrelated"]);
    fixtures.push(f);
    const page = await searchHistory(f.repo, "checkpoint", { limit: 1 });
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]!.kind).toBe("history");
    if (page.hits[0]!.kind !== "history") throw new Error("unreachable");
    expect(page.hits[0]!.snippet).toContain("checkpoint");

    const second = await searchHistory(f.repo, "checkpoint", { cursor: page.nextCursor, limit: 1 });
    expect(second.hits).toHaveLength(1);
    if (second.hits[0]!.kind !== "history") throw new Error("unreachable");
    expect(second.hits[0]!.state).not.toBe(page.hits[0]!.state);

    expect((await searchHistory(f.repo, "^checkpoint (alpha|beta)$", {})).hits).toHaveLength(2);
  });

  test("searchProvenance scans stored records", async () => {
    const f = await buildRepo([{ "code.ts": "value\n" }], ["agent work"]);
    fixtures.push(f);
    await f.repo.recordProvenance({
      states: [f.head],
      agent: { name: "codex", adapter: "codex" },
      startedAt: new Date().toISOString(),
      summary: "reflowed the layout engine",
    });
    const byAgent = await searchProvenance(f.repo, "codex");
    expect(byAgent.hits).toHaveLength(1);
    if (byAgent.hits[0]!.kind !== "provenance") throw new Error("unreachable");
    expect(byAgent.hits[0]!.snippet).toContain("layout engine");

    expect((await searchProvenance(f.repo, "layout")).hits).toHaveLength(1);
    expect(await searchProvenance(f.repo, "nomatch")).toEqual({ hits: [] });
  });
});
