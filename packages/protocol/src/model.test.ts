import { describe, expect, test } from "bun:test";
import { isObjectId, objectId } from "./index";
import { type EvidenceRecord, type TreeEntry } from "./model";

describe("model v2", () => {
  test("tree entry carries mode", () => {
    const id = objectId("d".repeat(64));
    const entry: TreeEntry = { name: "run.sh", mode: "exec", kind: "blob", id };
    expect(entry.mode).toBe("exec");
  });

  test("evidence binds state, rules, environment", () => {
    const id = objectId("e".repeat(64));
    const ev: EvidenceRecord = {
      kind: "evidence",
      state: id,
      rules: "ci@sha256:abc",
      environment: "macos-14",
      checks: [{ check: "build", status: "pass" }],
      at: new Date(0).toISOString(),
    };
    expect(ev.checks[0]!.status).toBe("pass");
    expect(isObjectId(ev.state)).toBe(true);
  });
});
