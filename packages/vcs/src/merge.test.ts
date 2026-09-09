import { describe, expect, test } from "bun:test";
import { diff3, joinLines, splitLines } from "./merge";

function merge(base: string, ours: string, theirs: string): string | null {
  const result = diff3(splitLines(base), splitLines(ours), splitLines(theirs));
  return result.lines === null ? null : new TextDecoder().decode(joinLines(result.lines));
}

describe("diff3", () => {
  test("no changes returns base", () => {
    expect(merge("a\nb\nc\n", "a\nb\nc\n", "a\nb\nc\n")).toBe("a\nb\nc\n");
  });

  test("different lines of the same file merge cleanly", () => {
    expect(merge("one\ntwo\nthree\nfour\nfive\n", "ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nFIVE\n")).toBe(
      "ONE\ntwo\nthree\nfour\nFIVE\n",
    );
  });

  test("same line changed on both sides conflicts", () => {
    expect(merge("a\nb\nc\n", "A\nb\nc\n", "a2\nb\nc\n")).toBeNull();
  });

  test("identical change on both sides is taken once", () => {
    expect(merge("a\nb\n", "a\nb\nx\n", "a\nb\nx\n")).toBe("a\nb\nx\n");
  });

  test("one-sided insertion is taken", () => {
    expect(merge("a\nb\nc\n", "a\ninsert\nb\nc\n", "a\nb\nc\n")).toBe("a\ninsert\nb\nc\n");
    expect(merge("a\nb\nc\n", "a\nb\nc\n", "a\ninsert\nb\nc\n")).toBe("a\ninsert\nb\nc\n");
  });

  test("one-sided deletion is taken", () => {
    expect(merge("a\nb\nc\n", "a\nc\n", "a\nb\nc\n")).toBe("a\nc\n");
    expect(merge("a\nb\nc\n", "a\nb\nc\n", "a\nc\n")).toBe("a\nc\n");
  });

  test("competing additions at the same spot conflict", () => {
    expect(merge("a\nb\n", "a\nours\nb\n", "a\ntheirs\nb\n")).toBeNull();
  });

  test("additions at the end by both sides", () => {
    expect(merge("a\n", "a\nb\n", "a\nc\n")).toBeNull();
    expect(merge("a\n", "a\nb\n", "a\n")).toBe("a\nb\n");
    expect(merge("a\n", "a\n", "a\nb\n")).toBe("a\nb\n");
  });

  test("adjacent but disjoint hunks merge", () => {
    expect(merge("a\nb\nc\nd\n", "A\nb\nc\nd\n", "a\nb\nc\nD\n")).toBe("A\nb\nc\nD\n");
  });

  test("adjacent-line edits on a 2-line file merge", () => {
    expect(merge("a\nb\n", "A\nb\n", "a\nB\n")).toBe("A\nB\n");
  });

  test("empty base with content on one side", () => {
    expect(merge("", "ours\n", "")).toBe("ours\n");
    expect(merge("", "", "theirs\n")).toBe("theirs\n");
    expect(merge("", "ours\n", "theirs\n")).toBeNull();
  });
});
