import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectId } from "../../protocol/src/model";
import { Repository } from "@javelin/vcs";
import { evaluatePublish, getPolicy, PolicyError, recordCheck, setPolicy } from "./index";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jvl-policy-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function initRepo(name: string): Promise<Repository> {
  return Repository.init(join(root, name));
}

/** Layer, checkpoint, and contribution built through the real vcs v2 flow. */
async function contribute(repo: Repository, file = "a.txt", content = "a"): Promise<{ id: ObjectId; state: ObjectId }> {
  await repo.layerNew("dev");
  await repo.layerSwitch("dev");
  await writeFile(join(repo.root, file), content);
  const { stateId } = await repo.checkpoint({ message: `add ${file}` });
  const id = await repo.contribute("dev", `add ${file}`, { name: "tester", email: "tester@javelin.dev" });
  return { id, state: stateId };
}

function pass(check: string) {
  return { check, status: "pass" as const };
}
function fail(check: string) {
  return { check, status: "fail" as const };
}

describe("evaluatePublish", () => {
  test("no policy is ok immediately", async () => {
    const repo = await initRepo("free");
    const { id } = await contribute(repo);
    const result = await evaluatePublish(repo, id);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("missing evidence names the check", async () => {
    const repo = await initRepo("missing");
    await setPolicy(repo, { requireEvidence: [{ check: "build" }] });
    const { id, state } = await contribute(repo);
    const result = await evaluatePublish(repo, id);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { check: "build", detail: `no evidence for check 'build' on ${state.slice(0, 12)}` },
    ]);
  });

  test("pass evidence for the exact state satisfies the policy", async () => {
    const repo = await initRepo("happy");
    await setPolicy(repo, { requireEvidence: [{ check: "build" }] });
    const { id, state } = await contribute(repo);
    await recordCheck(repo, {
      state,
      rules: "ci-rules@1",
      environment: "linux-x64",
      checks: [pass("build")],
    });
    const result = await evaluatePublish(repo, id);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("fail-status evidence violates", async () => {
    const repo = await initRepo("failing");
    await setPolicy(repo, { requireEvidence: [{ check: "build" }] });
    const { id, state } = await contribute(repo);
    await recordCheck(repo, { state, rules: "ci-rules@1", checks: [fail("build")] });
    const result = await evaluatePublish(repo, id);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { check: "build", detail: `evidence for check 'build' on ${state.slice(0, 12)} has status 'fail'` },
    ]);
  });

  test("mismatched rules violate when the policy pins rules", async () => {
    const repo = await initRepo("rules");
    await setPolicy(repo, { requireEvidence: [{ check: "build", rules: "ci-rules@2" }] });
    const { id, state } = await contribute(repo);
    await recordCheck(repo, { state, rules: "ci-rules@1", checks: [pass("build")] });
    const result = await evaluatePublish(repo, id);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.check).toBe("build");
    expect(result.violations[0]!.detail).toContain("ci-rules@1");
    await recordCheck(repo, { state, rules: "ci-rules@2", checks: [pass("build")] });
    expect((await evaluatePublish(repo, id)).ok).toBe(true);
  });

  test("evidence bound to a different state does not satisfy", async () => {
    const repo = await initRepo("other-state");
    await setPolicy(repo, { requireEvidence: [{ check: "build" }] });
    const { id, state } = await contribute(repo);
    await writeFile(join(repo.root, "b.txt"), "b");
    const second = await repo.checkpoint({ message: "add b" });
    await recordCheck(repo, { state: second.stateId, rules: "ci-rules@1", checks: [pass("build")] });
    const result = await evaluatePublish(repo, id);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.detail).toContain(state.slice(0, 12));
  });

  test("requiredContribution passes for an open contribution at the layer head and fails when stale", async () => {
    const repo = await initRepo("stale");
    await setPolicy(repo, { requiredContribution: true });
    const { id } = await contribute(repo);
    expect((await evaluatePublish(repo, id)).ok).toBe(true);
    await writeFile(join(repo.root, "a.txt"), "changed");
    await repo.checkpoint({ message: "edit a" });
    const result = await evaluatePublish(repo, id);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.check).toBe("required-contribution");
  });

  test("requiredContribution fails for a contribution that is not open", async () => {
    const repo = await initRepo("discarded");
    await setPolicy(repo, { requiredContribution: true });
    const { id } = await contribute(repo);
    const key = `contrib/${id}`;
    const raw = (await repo.meta.get(key))!;
    const meta = JSON.parse(raw) as { status: string; events: unknown[] };
    const event = { status: "discarded", at: new Date().toISOString() };
    await repo.meta.compareAndSwap(key, raw, JSON.stringify({ ...meta, status: "discarded", events: [...meta.events, event] }));
    const result = await evaluatePublish(repo, id);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.detail).toContain("discarded");
  });

  test("evaluatePublish throws for an unknown contribution", async () => {
    const repo = await initRepo("nope");
    expect(evaluatePublish(repo, "0".repeat(64) as ObjectId)).rejects.toThrow(PolicyError);
  });
});

describe("setPolicy/getPolicy", () => {
  test("CAS round-trips through repo meta", async () => {
    const repo = await initRepo("meta");
    expect(await getPolicy(repo)).toBeNull();
    await setPolicy(repo, { requireEvidence: [{ check: "build", rules: "ci-rules@1" }], requiredContribution: true });
    expect(await getPolicy(repo)).toEqual({
      requireEvidence: [{ check: "build", rules: "ci-rules@1" }],
      requiredContribution: true,
    });
    await setPolicy(repo, { requireEvidence: [] });
    expect(await getPolicy(repo)).toEqual({ requireEvidence: [] });
    await setPolicy(repo, null);
    expect(await getPolicy(repo)).toBeNull();
  });

  test("empty policy object is valid and means no requirements", async () => {
    const repo = await initRepo("empty");
    await setPolicy(repo, {});
    expect(await getPolicy(repo)).toEqual({});
  });

  test("invalid shapes are rejected", async () => {
    const repo = await initRepo("invalid");
    const bad: unknown[] = [
      "policy",
      { unknownKey: true },
      { requireEvidence: "build" },
      { requireEvidence: ["build"] },
      { requireEvidence: [{ check: "" }] },
      { requireEvidence: [{ rules: "r" }] },
      { requireEvidence: [{ check: "build", rules: "" }] },
      { requireEvidence: [{ check: "build", unknown: 1 }] },
      { requiredContribution: "yes" },
    ];
    for (const policy of bad) {
      expect(setPolicy(repo, policy as never)).rejects.toThrow(PolicyError);
    }
    expect(await getPolicy(repo)).toBeNull();
  });

  test("a malformed stored policy throws on read", async () => {
    const repo = await initRepo("corrupt");
    await setPolicy(repo, { requireEvidence: [{ check: "build" }] });
    await Bun.write(join(repo.root, ".javelin", "meta", "policy"), "{not json");
    expect(getPolicy(repo)).rejects.toThrow(PolicyError);
  });
});

describe("publish flow with policy", () => {
  test("violations disappear once evidence is recorded, then vcs publish succeeds", async () => {
    const repo = await initRepo("flow");
    await setPolicy(repo, {
      requireEvidence: [{ check: "build" }, { check: "lint", rules: "lint-rules@1" }],
      requiredContribution: true,
    });
    const { id, state } = await contribute(repo);
    const before = await evaluatePublish(repo, id);
    expect(before.ok).toBe(false);
    expect(before.violations.map((v) => v.check).sort()).toEqual(["build", "lint"]);

    await recordCheck(repo, { state, rules: "ci-rules@1", environment: "linux-x64", checks: [pass("build")] });
    const afterOne = await evaluatePublish(repo, id);
    expect(afterOne.ok).toBe(false);
    expect(afterOne.violations.map((v) => v.check)).toEqual(["lint"]);

    await recordCheck(repo, { state, rules: "lint-rules@1", checks: [pass("lint")] });
    const afterAll = await evaluatePublish(repo, id);
    expect(afterAll.ok).toBe(true);
    expect(afterAll.violations).toEqual([]);

    const published = await repo.publish(id, { name: "tester", email: "tester@javelin.dev" });
    expect(published.ok).toBe(true);
  });
});
