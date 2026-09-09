import { describe, expect, test } from "bun:test";
import { isObjectId, objectId, type Commit, type Tree } from "./index";

describe("protocol", () => {
  test("objectId accepts sha256 hex and rejects anything else", () => {
    const id = objectId("a".repeat(64));
    expect(isObjectId(id)).toBe(true);
    expect(() => objectId("zz")).toThrow();
    expect(isObjectId("a".repeat(63))).toBe(false);
  });

  test("tree and commit shapes serialize canonically", () => {
    const id = objectId("b".repeat(64));
    const tree: Tree = { kind: "tree", entries: [{ name: "README.md", kind: "blob", id }] };
    const json = JSON.parse(JSON.stringify(tree));
    expect(json.entries[0].kind).toBe("blob");
    const commit: Commit = {
      kind: "commit",
      tree: id,
      parents: [],
      author: { name: "t", email: "t@x", time: new Date(0).toISOString() },
      committer: { name: "t", email: "t@x", time: new Date(0).toISOString() },
      message: "init",
    };
    expect(commit.parents).toHaveLength(0);
  });
});

import { type State, type ProvenanceRecord, type Contribution, type LayerRef } from "./model";

describe("model v2", () => {
  test("state and provenance shapes serialize", () => {
    const id = objectId("c".repeat(64));
    const state: State = {
      kind: "state",
      tree: id,
      parents: [],
      author: { name: "a", email: "a@x", time: new Date(0).toISOString() },
      message: "checkpoint",
    };
    const prov: ProvenanceRecord = {
      kind: "provenance",
      states: [id],
      agent: { name: "codex", adapter: "codex" },
      startedAt: new Date(0).toISOString(),
    };
    expect(JSON.parse(JSON.stringify(prov)).states[0]).toBe(id);
    const contrib: Contribution = {
      kind: "contribution",
      layer: "fix-bug",
      state: id,
      base: id,
      title: "Fix bug",
      author: state.author,
      createdAt: new Date(0).toISOString(),
    };
    const layer: LayerRef = { name: "fix-bug", base: id, head: null, updatedAt: new Date(0).toISOString() };
    expect(layer.head).toBeNull();
    expect(contrib.state).toBe(id);
  });
});
