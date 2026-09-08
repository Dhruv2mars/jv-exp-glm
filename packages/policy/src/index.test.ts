import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectId, type EvidenceRecord, type ObjectId } from "@javelin/protocol";
import { openRepository, type Repository } from "@javelin/vcs";
import { attachEvidence, evaluatePolicy, getPolicy, setPolicy } from "./index";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jvl-policy-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function bootstrap(name: string): Promise<string> {
  const repoRoot = join(root, name);
  await openRepository(repoRoot);
  await Bun.write(
    join(repoRoot, ".javelin", "meta.json"),
    JSON.stringify({ name, createdAt: "2026-09-09T00:00:00Z", defaultBranch: "main" }) + "\n",
  );
  return repoRoot;
}

async function createRepo(name = "r"): Promise<Repository> {
  return openRepository(await bootstrap(name));
}

async function commitFile(repo: Repository, path: string, content: string, message: string): Promise<ObjectId> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
  await repo.stage(path, new TextEncoder().encode(content));
  return repo.commit({ message });
}

function evidence(check: string, status: "pass" | "fail" = "pass"): EvidenceRecord {
  return { kind: "evidence", run: "run-1", check, status, at: "2026-09-09T00:00:00Z" };
}

describe("evaluatePolicy", () => {
  test("no policy passes", async () => {
    const repo = await createRepo();
    const head = await commitFile(repo, "a.txt", "a", "one");
    const result = await evaluatePolicy(repo, head, null);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("policy with empty requireEvidence passes", async () => {
    const repo = await createRepo();
    const head = await commitFile(repo, "a.txt", "a", "one");
    const result = await evaluatePolicy(repo, head, { requireEvidence: [] });
    expect(result.ok).toBe(true);
  });

  test("passing evidence on head satisfies the check", async () => {
    const repo = await createRepo();
    const head = await commitFile(repo, "a.txt", "a", "one");
    const attached = await attachEvidence(repo, head, evidence("ci-green"));
    expect(attached.attached).toBe(true);
    const result = await evaluatePolicy(repo, attached.commitId, { requireEvidence: ["ci-green"] });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("missing evidence violates with the check name", async () => {
    const repo = await createRepo();
    const head = await commitFile(repo, "a.txt", "a", "one");
    const result = await evaluatePolicy(repo, head, { requireEvidence: ["ci-green"] });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.check).toBe("ci-green");
  });

  test("failing evidence status violates", async () => {
    const repo = await createRepo();
    const head = await commitFile(repo, "a.txt", "a", "one");
    const attached = await attachEvidence(repo, head, evidence("ci-green", "fail"));
    const result = await evaluatePolicy(repo, attached.commitId, { requireEvidence: ["ci-green"] });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.check).toBe("ci-green");
  });

  test("evidence on an ancestor satisfies the head check", async () => {
    const repo = await createRepo();
    const base = await commitFile(repo, "a.txt", "a", "base");
    const attached = await attachEvidence(repo, base, evidence("ci-green"));
    await repo.checkout("main");
    const head = await commitFile(repo, "b.txt", "b", "child");
    expect(head).not.toEqual(attached.commitId);
    const result = await evaluatePolicy(repo, head, { requireEvidence: ["ci-green"] });
    expect(result.ok).toBe(true);
  });
});

describe("setPolicy/getPolicy", () => {
  test("round-trips in javelind meta.json and preserves other fields", async () => {
    const repoRoot = await bootstrap("meta");
    await setPolicy(repoRoot, { requireEvidence: ["ci-green"] });
    const policy = await getPolicy(repoRoot);
    expect(policy).toEqual({ requireEvidence: ["ci-green"] });
    const meta = JSON.parse(await Bun.file(join(repoRoot, ".javelin", "meta.json")).text());
    expect(meta.name).toBe("meta");
    expect(meta.defaultBranch).toBe("main");
    expect(meta.createdAt).toBeString();
    expect(await getPolicy(repoRoot)).toEqual({ requireEvidence: ["ci-green"] });
  });

  test("setPolicy(null) removes the policy", async () => {
    const repoRoot = await bootstrap("meta2");
    await setPolicy(repoRoot, { requireEvidence: ["ci-green"] });
    await setPolicy(repoRoot, null);
    expect(await getPolicy(repoRoot)).toBeNull();
  });

  test("setPolicy throws when meta.json is missing", async () => {
    expect(setPolicy(join(root, "nope"), { requireEvidence: ["x"] })).rejects.toThrow();
  });
});

describe("attachEvidence", () => {
  test("moves the ref and is idempotent", async () => {
    const repo = await createRepo();
    const head = await commitFile(repo, "a.txt", "a", "one");
    const first = await attachEvidence(repo, head, evidence("ci-green"));
    expect(first.attached).toBe(true);
    expect(first.commitId).not.toEqual(head);
    const ref = await repo.refs.get("refs/heads/main");
    expect(ref).toEqual(first.commitId);
    const second = await attachEvidence(repo, first.commitId, evidence("ci-green"));
    expect(second.attached).toBe(false);
    expect(second.commitId).toEqual(first.commitId);
    expect(second.evidenceId).toEqual(objectId(first.evidenceId));
  });
});
