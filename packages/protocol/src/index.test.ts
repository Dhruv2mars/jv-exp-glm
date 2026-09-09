import { describe, expect, test } from "bun:test";
import { isObjectId, objectId, type State, type TreeEntry } from "./index";

describe("protocol", () => {
  test("objectId accepts sha256 hex and rejects anything else", () => {
    const id = objectId("a".repeat(64));
    expect(isObjectId(id)).toBe(true);
    expect(() => objectId("zz")).toThrow();
    expect(isObjectId("a".repeat(63))).toBe(false);
  });

  test("v2 model shapes are exported from the package root", () => {
    const id = objectId("b".repeat(64));
    const entry: TreeEntry = { name: "run.sh", mode: "exec", kind: "blob", id };
    expect(entry.mode).toBe("exec");
    const state: State = {
      kind: "state",
      tree: id,
      parents: [],
      author: { name: "t", email: "t@x", time: new Date(0).toISOString() },
      message: "init",
    };
    expect(state.parents).toHaveLength(0);
  });
});
