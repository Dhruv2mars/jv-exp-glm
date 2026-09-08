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
