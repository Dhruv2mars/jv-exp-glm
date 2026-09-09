import { describe, expect, test } from "bun:test";
import {
  CONTRIBUTION_TRANSITIONS,
  ERROR_HTTP_STATUS,
  MAX_BATCH_BYTES,
  MAX_OBJECT_BYTES,
  LimitExceededError,
  assertBatchWithinLimits,
  assertObjectWithinLimits,
  cursor,
  decodeBase64,
  decodeWireBlob,
  encodeBase64,
  encodeWireBlob,
  isLegalContributionTransition,
  objectId,
  routes,
} from "./index";
import type { HeadUpdate, HeadUpdateResult, ListReposPage, WireObject } from "./index";

const hex = (c: string) => objectId(c.repeat(64));

function sampleBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = i % 256;
  return bytes;
}

describe("jrp base64", () => {
  test("binary bytes including 0xFF survive the round trip", () => {
    const bytes = sampleBytes(1024);
    expect(bytes[255]).toBe(255);
    const out = decodeBase64(encodeBase64(bytes));
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  test("blob wire objects survive JSON stringify/parse", () => {
    const wire = encodeWireBlob(hex("a"), sampleBytes(512));
    expect(wire.kind).toBe("blob");
    const parsed = JSON.parse(JSON.stringify(wire)) as WireObject;
    const out = decodeWireBlob(parsed);
    expect(out.byteLength).toBe(512);
    expect(out[511]).toBe(255);
  });

  test("structured wire objects survive JSON stringify/parse", () => {
    const treeId = hex("b");
    const state: WireObject = {
      id: hex("c"),
      kind: "state",
      object: {
        kind: "state",
        tree: treeId,
        parents: [],
        author: { name: "a", email: "a@x", time: new Date(0).toISOString() },
        message: "checkpoint",
      },
    };
    const parsed = JSON.parse(JSON.stringify(state)) as WireObject;
    expect(parsed.kind).toBe("state");
    if (parsed.kind === "state") {
      expect(parsed.object.tree).toBe(treeId);
    }
  });

  test("decodeWireBlob rejects non-blobs and corrupt base64", () => {
    const tree: WireObject = { id: hex("d"), kind: "tree", object: { kind: "tree", entries: [] } };
    expect(() => decodeWireBlob(tree)).toThrow();
    expect(() => decodeBase64("!!!not-base64!!!")).toThrow();
  });
});

describe("jrp limits", () => {
  test("encodeWireBlob accepts exactly MAX_OBJECT_BYTES and rejects one byte more", () => {
    const id = hex("e");
    expect(encodeWireBlob(id, new Uint8Array(MAX_OBJECT_BYTES)).data.length).toBeGreaterThan(0);
    expect(() => encodeWireBlob(id, new Uint8Array(MAX_OBJECT_BYTES + 1))).toThrow(LimitExceededError);
  });

  test("assertObjectWithinLimits rejects oversize blobs without decoding", () => {
    const oversize = encodeBase64(new Uint8Array(MAX_OBJECT_BYTES + 1));
    const wire: WireObject = { id: hex("f"), kind: "blob", data: oversize };
    expect(() => assertObjectWithinLimits(wire)).toThrow(LimitExceededError);
    const small: WireObject = { id: hex("f"), kind: "blob", data: encodeBase64(new Uint8Array(16)) };
    expect(() => assertObjectWithinLimits(small)).not.toThrow();
  });

  test("assertBatchWithinLimits rejects batches over MAX_BATCH_BYTES", () => {
    const id = hex("1");
    const blob = encodeWireBlob(id, new Uint8Array(MAX_OBJECT_BYTES));
    expect(() => assertBatchWithinLimits(Array.from({ length: 8 }, () => blob))).toThrow(LimitExceededError);
    expect(() => assertBatchWithinLimits([blob])).not.toThrow();
  });
});

describe("jrp wire types", () => {
  test("cursors are non-empty opaque branded strings", () => {
    const c = cursor("b2Zmc2V0OjEwMA");
    const page: ListReposPage = { repos: [], nextCursor: c };
    expect(page.nextCursor).toBe(c);
    expect(() => cursor("")).toThrow();
  });

  test("head updates key world and layer pointers", () => {
    const id = hex("2");
    const updates: HeadUpdate[] = [
      { key: "world", expected: null, next: id },
      { key: "layer/agent-x", expected: id, next: null },
    ];
    const results: HeadUpdateResult[] = [
      { key: "world", ok: true },
      { key: "layer/agent-x", ok: false, reason: "cas-mismatch" },
    ];
    expect(updates).toHaveLength(2);
    expect(results[1]).toEqual({ key: "layer/agent-x", ok: false, reason: "cas-mismatch" });
  });

  test("contribution transitions close open work and never reopen", () => {
    expect(CONTRIBUTION_TRANSITIONS.open).toEqual(["published", "discarded"]);
    expect(CONTRIBUTION_TRANSITIONS.published).toEqual([]);
    expect(isLegalContributionTransition("open", "published")).toBe(true);
    expect(isLegalContributionTransition("open", "discarded")).toBe(true);
    expect(isLegalContributionTransition("published", "open")).toBe(false);
    expect(isLegalContributionTransition("discarded", "published")).toBe(false);
  });

  test("every error code maps to an HTTP status", () => {
    expect(ERROR_HTTP_STATUS.bad_request).toBe(400);
    expect(ERROR_HTTP_STATUS.unauthorized).toBe(401);
    expect(ERROR_HTTP_STATUS.forbidden).toBe(403);
    expect(ERROR_HTTP_STATUS.not_found).toBe(404);
    expect(ERROR_HTTP_STATUS.conflict).toBe(409);
    expect(ERROR_HTTP_STATUS.version_not_supported).toBe(409);
    expect(ERROR_HTTP_STATUS.payload_too_large).toBe(413);
    expect(ERROR_HTTP_STATUS.internal).toBe(500);
  });

  test("route strings match the spec paths", () => {
    expect(routes.repos).toBe("/jrp/v2/repos");
    expect(routes.heads("demo")).toBe("/jrp/v2/repos/demo/heads");
    expect(routes.headsUpdate("demo")).toBe("/jrp/v2/repos/demo/heads/update");
    expect(routes.objectsBatchFetch("demo")).toBe("/jrp/v2/repos/demo/objects/batch-fetch");
    expect(routes.objectsBatchUpload("demo")).toBe("/jrp/v2/repos/demo/objects/batch-upload");
    expect(routes.raw("demo", "ab12")).toBe("/jrp/v2/repos/demo/raw/ab12");
    expect(routes.statesLog("demo")).toBe("/jrp/v2/repos/demo/states/log");
    expect(routes.provenanceQuery("demo")).toBe("/jrp/v2/repos/demo/provenance/query");
    expect(routes.evidenceQuery("demo")).toBe("/jrp/v2/repos/demo/evidence/query");
    expect(routes.contributions("demo")).toBe("/jrp/v2/repos/demo/contributions");
    expect(routes.contributionStatus("demo", "c1")).toBe("/jrp/v2/repos/demo/contributions/c1/status");
    expect(routes.search("demo")).toBe("/jrp/v2/repos/demo/search");
    expect(routes.healthz).toBe("/jrp/v2/healthz");
    expect(routes.readyz).toBe("/jrp/v2/readyz");
  });
});
