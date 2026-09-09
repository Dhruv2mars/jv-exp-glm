import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectId } from "../../protocol/src/model";
import { init, openRepository, Repository, type Author, type FileMap, type MergeConflict, type PublishResult } from "./repo";

const AUTHOR: Author = { name: "agent", email: "agent@javelin.dev" };

let root: string;
let root2: string;
let clones: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jvl-repo-"));
  clones = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (root2) await rm(root2, { recursive: true, force: true });
  for (const clone of clones) await rm(clone, { recursive: true, force: true });
});

/** Move world forward by publishing a scratch layer whose edit runs against the current world head. */
async function publishEdit(
  repo: Repository,
  layerName: string,
  message: string,
  edit: () => Promise<void>,
): Promise<ObjectId> {
  await repo.layerNew(layerName);
  await repo.layerSwitch(layerName);
  await edit();
  await repo.checkpoint({ message, author: AUTHOR });
  const id = await repo.contribute(layerName, message, AUTHOR);
  const result = await repo.publish(id, AUTHOR);
  if (!result.ok) throw new Error(`setup publish failed: ${result.reason}`);
  return result.worldState!;
}

async function forkAndCheckpoint(
  repo: Repository,
  layerName: string,
  message: string,
  edit?: () => Promise<void>,
): Promise<ObjectId> {
  await repo.layerNew(layerName);
  await repo.layerSwitch(layerName);
  await edit?.();
  return (await repo.checkpoint({ message, author: AUTHOR })).stateId;
}

async function freshClone(repo: Repository, stateId: ObjectId): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jvl-clone-"));
  clones.push(dir);
  await repo.materialize(stateId, dir);
  return dir;
}

describe("Repository v2", () => {
  test("init creates a world head and is idempotent", async () => {
    const repo = await init(root);
    const head = await repo.worldHead();
    expect(head).not.toBeNull();
    const again = await init(root);
    expect(await again.worldHead()).toBe(head);
    const reopened = await openRepository(root);
    expect(await reopened.worldHead()).toBe(head);
    expect(await repo.currentLayer()).toBe("world");
  });

  test("lifecycle: layer, checkpoint, contribute, publish, clone-like materialize", async () => {
    const repo = await init(root);
    const base = await repo.worldHead();
    const layer = await repo.layerNew("agent-a");
    expect(layer.base).toBe(base!);
    expect(layer.head).toBeNull();
    await repo.layerSwitch("agent-a");
    await writeFile(join(root, "hello.txt"), "hello world\n");
    await writeFile(join(root, "run.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(root, "run.sh"), 0o755);
    await symlink("hello.txt", join(root, "link.txt"));
    const cp = await repo.checkpoint({ message: "greet", author: AUTHOR });
    expect(cp.layer).toBe("agent-a");
    expect((await repo.layerGet("agent-a"))!.head).toBe(cp.stateId);

    const contribId = await repo.contribute("agent-a", "greet the world", AUTHOR);
    const pub = await repo.publish(contribId, AUTHOR);
    expect(pub.ok).toBe(true);
    const world = await repo.worldHead();
    expect(pub.worldState).toBe(world);

    const log = await repo.worldLog(10);
    expect(log.map((entry) => entry.state.message)).toEqual([
      "publish agent-a: greet the world",
      "greet",
      "init",
    ]);

    const clone = await freshClone(repo, world!);
    expect(await readFile(join(clone, "hello.txt"), "utf8")).toBe("hello world\n");
    expect(((await stat(join(clone, "run.sh"))).mode & 0o111) !== 0).toBe(true);
    expect(await readlink(join(clone, "link.txt"))).toBe("hello.txt");

    const stored = await repo.contribution(contribId);
    expect(stored!.meta.status).toBe("published");
    expect(stored!.meta.events.at(-1)!.worldState).toBe(world!);
    expect(stored!.contribution.state).toBe(cp.stateId);
    expect(stored!.contribution.base).toBe(base!);
  });

  test("materialize applies deletions of files absent in the target state", async () => {
    const repo = await init(root);
    await repo.layerNew("w");
    await repo.layerSwitch("w");
    await writeFile(join(root, "keep.txt"), "keep\n");
    await writeFile(join(root, "drop.txt"), "drop\n");
    const first = await repo.checkpoint({ message: "two files", author: AUTHOR });
    await rm(join(root, "drop.txt"));
    const second = await repo.checkpoint({ message: "one file", author: AUTHOR });

    await repo.materialize(first.stateId);
    expect(existsSync(join(root, "drop.txt"))).toBe(true);
    await repo.materialize(second.stateId);
    expect(existsSync(join(root, "drop.txt"))).toBe(false);
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("keep\n");
  });

  test("scanWorkingDir captures nested paths, exec bit, and symlinks", async () => {
    const repo = await init(root);
    await repo.layerNew("modes");
    await repo.layerSwitch("modes");
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "src", "deep", "main.ts"), "export {};\n");
    await writeFile(join(root, "src", "tool.sh"), "#!/bin/sh\n");
    await chmod(join(root, "src", "tool.sh"), 0o755);
    await symlink("../tool.sh", join(root, "src", "alias"));
    const cp = await repo.checkpoint({ message: "modes", author: AUTHOR });
    const clone = await freshClone(repo, cp.stateId);
    expect(await readFile(join(clone, "src", "deep", "main.ts"), "utf8")).toBe("export {};\n");
    expect(((await stat(join(clone, "src", "tool.sh"))).mode & 0o111) !== 0).toBe(true);
    expect(await readlink(join(clone, "src", "alias"))).toBe("../tool.sh");
  });

  test("refresh merges different-line edits of the same file without conflict", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "file.txt"), "one\ntwo\nthree\nfour\nfive\n");
    });
    await forkAndCheckpoint(repo, "work", "edit first line", async () => {
      await writeFile(join(root, "file.txt"), "ONE\ntwo\nthree\nfour\nfive\n");
    });
    await publishEdit(repo, "worldside", "edit last line", async () => {
      await writeFile(join(root, "file.txt"), "one\ntwo\nthree\nfour\nFIVE\n");
    });

    const result = await repo.refresh("work");
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    const log = await repo.layerLog("work");
    const world = await repo.worldHead();
    expect(log[0]!.state.parents).toContain(world!);
  });

  test("refresh reports a conflict on competing same-line edits and changes nothing", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "file.txt"), "x\ny\n");
    });
    const cp = await forkAndCheckpoint(repo, "work", "ours", async () => {
      await writeFile(join(root, "file.txt"), "X\ny\n");
    });
    await publishEdit(repo, "worldside", "theirs", async () => {
      await writeFile(join(root, "file.txt"), "Z\ny\n");
    });
    const worldBefore = await repo.worldHead();

    const result = await repo.refresh("work");
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.path).toBe("file.txt");
    expect(result.conflicts[0]!.kind).toBe("content");
    expect(result.conflicts[0]!.baseId).not.toBeNull();
    expect(result.conflicts[0]!.oursId).not.toBe(result.conflicts[0]!.theirsId);
    expect((await repo.layerGet("work"))!.head).toBe(cp);
    expect(await repo.worldHead()).toBe(worldBefore);
    expect(await repo.layerLog("work")).toHaveLength(1);
  });

  test("a file added to world after the fork appears in the layer after refresh", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "base.txt"), "base\n");
    });
    await forkAndCheckpoint(repo, "fork", "layer work", async () => {
      await writeFile(join(root, "mine.txt"), "mine\n");
    });
    await publishEdit(repo, "adder", "world adds a file", async () => {
      await writeFile(join(root, "worlds.txt"), "from world\n");
    });

    const result = await repo.refresh("fork");
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, "worlds.txt"), "utf8")).toBe("from world\n");
    expect(await readFile(join(root, "mine.txt"), "utf8")).toBe("mine\n");
    expect(await readFile(join(root, "base.txt"), "utf8")).toBe("base\n");
  });

  test("deletion semantics: theirs deleted and ours unmodified deletes the file", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "a.txt"), "a\n");
      await writeFile(join(root, "b.txt"), "b\n");
    });
    await forkAndCheckpoint(repo, "d1", "no changes");
    await publishEdit(repo, "worldside", "delete b", async () => {
      await rm(join(root, "b.txt"));
    });

    const result = await repo.refresh("d1");
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a\n");
  });

  test("deletion semantics: ours deleted and theirs unmodified stays deleted", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "a.txt"), "a\n");
      await writeFile(join(root, "b.txt"), "b\n");
    });
    await forkAndCheckpoint(repo, "d2", "delete b locally", async () => {
      await rm(join(root, "b.txt"));
    });
    const worldBefore = await repo.worldHead();

    const result = await repo.refresh("d2");
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(await repo.worldHead()).toBe(worldBefore);
  });

  test("deletion semantics: both deleted deletes, delete plus modify conflicts", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "a.txt"), "a\n");
      await writeFile(join(root, "b.txt"), "b\n");
    });
    await forkAndCheckpoint(repo, "d3", "delete b", async () => {
      await rm(join(root, "b.txt"));
    });
    await publishEdit(repo, "worldside", "also delete b", async () => {
      await rm(join(root, "b.txt"));
    });
    const result = await repo.refresh("d3");
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "b.txt"))).toBe(false);

    root2 = await mkdtemp(join(tmpdir(), "jvl-repo-"));
    const second = await init(root2);
    await publishEdit(second, "seed2", "seed with b", async () => {
      await writeFile(join(root2, "a.txt"), "a\n");
      await writeFile(join(root2, "b.txt"), "b\n");
    });
    const cp = await forkAndCheckpoint(second, "dm", "keep both");
    await second.layerSwitch("dm");
    await rm(join(root2, "b.txt"));
    await second.checkpoint({ message: "delete b", author: AUTHOR });
    await publishEdit(second, "worldside2", "modify b", async () => {
      await writeFile(join(root2, "b.txt"), "modified\n");
    });
    const conflicted = await second.refresh("dm");
    expect(conflicted.ok).toBe(false);
    expect(conflicted.conflicts).toHaveLength(1);
    expect(conflicted.conflicts[0]!.kind).toBe("delete-modify");
    expect(conflicted.conflicts[0]!.path).toBe("b.txt");
    expect((await second.layerGet("dm"))!.head).not.toBe(cp);
  });

  test("publish conflict leaves world untouched and the contribution open", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "file.txt"), "x\ny\n");
    });
    await repo.layerNew("p");
    await repo.layerSwitch("p");
    await writeFile(join(root, "file.txt"), "X\ny\n");
    await repo.checkpoint({ message: "ours", author: AUTHOR });
    const contribId = await repo.contribute("p", "change x", AUTHOR);
    await publishEdit(repo, "worldside", "competing change", async () => {
      await writeFile(join(root, "file.txt"), "Z\ny\n");
    });
    const worldBefore = await repo.worldHead();

    const result = await repo.publish(contribId, AUTHOR);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("conflict");
    expect(result.conflicts.map((c) => c.path)).toEqual(["file.txt"]);
    expect(await repo.worldHead()).toBe(worldBefore);
    expect((await repo.contribution(contribId))!.meta.status).toBe("open");
  });

  test("publishing twice is a no-op idempotent success", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "file.txt"), "x\n");
    });
    await forkAndCheckpoint(repo, "i1", "add file", async () => {
      await writeFile(join(root, "added.txt"), "added\n");
    });
    const contribId = await repo.contribute("i1", "add a file", AUTHOR);
    const first = await repo.publish(contribId, AUTHOR);
    expect(first.ok).toBe(true);
    const world = await repo.worldHead();
    expect(first.worldState).toBe(world);

    const second = await repo.publish(contribId, AUTHOR);
    expect(second.ok).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(await repo.worldHead()).toBe(world);
  });

  test("publish reports world-moved when the head advanced before the CAS and changes nothing", async () => {
    const repo = await init(root);
    await forkAndCheckpoint(repo, "slow", "work", async () => {
      await writeFile(join(root, "a.txt"), "a\n");
    });
    const contribId = await repo.contribute("slow", "propose", AUTHOR);
    const worldBefore = await repo.worldHead();

    class RacyRepo extends Repository {
      raced = false;
      constructor(rootPath: string, javelinDir: string) {
        super(rootPath, javelinDir);
      }
      protected override async casWorld(expectedRaw: string, next: ObjectId): Promise<boolean> {
        if (!this.raced) {
          this.raced = true;
          const initTree = await this.loadState(worldBefore!);
          const racer = {
            kind: "state" as const,
            tree: initTree.tree,
            parents: [worldBefore!],
            author: { name: "racer", email: "racer@x", time: new Date().toISOString() },
            message: "racer publish",
          };
          const { id } = await this.objects.write(racer);
          await this.meta.compareAndSwap("world", expectedRaw, JSON.stringify({ value: id }));
        }
        return super.casWorld(expectedRaw, next);
      }
    }
    const racy = new RacyRepo(root, join(root, ".javelin"));
    const result: PublishResult = await racy.publish(contribId, AUTHOR);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("world-moved");
    expect(await repo.worldHead()).not.toBe(worldBefore);
    expect((await repo.contribution(contribId))!.meta.status).toBe("open");
  });

  test("refresh fails loudly when a checkpoint lands mid-merge, keeping the checkpoint", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "file.txt"), "one\ntwo\nthree\n");
    });
    const cp = await forkAndCheckpoint(repo, "work", "layer edit", async () => {
      await writeFile(join(root, "file.txt"), "ONE\ntwo\nthree\n");
    });
    await publishEdit(repo, "worldside", "world edit", async () => {
      await writeFile(join(root, "file.txt"), "one\ntwo\nTHREE\n");
    });
    await repo.layerSwitch("work");

    class RacyRepo extends Repository {
      injected = false;
      constructor() {
        super(root, join(root, ".javelin"));
      }
      protected override async mergeTrees(
        baseState: ObjectId | null,
        oursState: ObjectId,
        theirsState: ObjectId,
      ): Promise<{ files: FileMap | null; conflicts: MergeConflict[] }> {
        if (!this.injected) {
          this.injected = true;
          const racer = await openRepository(root);
          await racer.checkpoint({ message: "mid-merge checkpoint", author: AUTHOR, layer: "work" });
        }
        return super.mergeTrees(baseState, oursState, theirsState);
      }
    }
    const racy = new RacyRepo();
    const result = await racy.refresh("work");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("layer-moved");

    const head = (await repo.layerGet("work"))!.head;
    expect(head).not.toBe(cp);
    const headState = await repo.loadState(head!);
    expect(headState.message).toBe("mid-merge checkpoint");
    expect(headState.parents).toEqual([cp]);

    const fsck = await repo.fsck();
    expect(fsck.ok).toBe(true);
    expect(fsck.unreachable).not.toContain(head!);
  });

  test("provenance and evidence are append-only references", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "a.txt"), "a\n");
    });
    const cp = await forkAndCheckpoint(repo, "prov", "work", async () => {
      await writeFile(join(root, "b.txt"), "b\n");
    });
    const headBefore = (await repo.layerGet("prov"))!.head;

    const provId = await repo.recordProvenance({
      states: [cp],
      agent: { name: "agent", adapter: "generic" },
      startedAt: new Date().toISOString(),
      exit: "success",
    });
    expect((await repo.layerGet("prov"))!.head).toBe(headBefore);
    const provs = await repo.provenanceFor(cp);
    expect(provs.map((hit) => hit.id)).toContain(provId);
    expect(provs[0]!.record.states).toEqual([cp]);

    const evId = await repo.recordEvidence({
      state: cp,
      rules: "ci@rev1",
      checks: [{ check: "build", status: "pass" }],
      at: new Date().toISOString(),
    });
    const evidence = await repo.evidenceFor(cp);
    expect(evidence.map((hit) => hit.id)).toContain(evId);
    expect(evidence[0]!.record.rules).toBe("ci@rev1");
    expect(await repo.provenanceFor((await repo.worldHead())!)).toEqual([]);
  });

  test("switching from a layer with extra files to world removes them", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "base.txt"), "base\n");
    });
    await forkAndCheckpoint(repo, "extra", "add extra", async () => {
      await writeFile(join(root, "extra.txt"), "extra\n");
    });
    expect(existsSync(join(root, "extra.txt"))).toBe(true);

    await repo.layerSwitch("world");
    expect(existsSync(join(root, "extra.txt"))).toBe(false);
    expect(await readFile(join(root, "base.txt"), "utf8")).toBe("base\n");
    expect(await repo.currentLayer()).toBe("world");
  });

  test("layerDiscard deletes metadata and objects become unreachable", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "a.txt"), "a\n");
    });
    const cp = await forkAndCheckpoint(repo, "temp", "scratch", async () => {
      await writeFile(join(root, "scratch.txt"), "scratch\n");
    });
    await repo.layerDiscard("temp");
    expect(await repo.layerGet("temp")).toBeNull();
    expect((await repo.layerList()).map((ref) => ref.name)).toEqual(["seed"]);
    expect((await repo.fsck()).unreachable).toContain(cp);
    await expect(repo.layerDiscard("temp")).rejects.toThrow("no such layer");
  });

  test("gc keeps reachable objects, removes an unreachable state, fsck clean after", async () => {
    const repo = await init(root);
    await publishEdit(repo, "seed", "seed", async () => {
      await writeFile(join(root, "a.txt"), "a\n");
    });
    const cp = await forkAndCheckpoint(repo, "temp", "scratch", async () => {
      await writeFile(join(root, "scratch.txt"), "scratch\n");
    });
    const state = await repo.loadState(cp);
    const tree = await repo.loadTree(state.tree);
    const scratchBlob = tree.entries.find((entry) => entry.name === "scratch.txt")!.id;

    expect((await repo.gc()).removed).toBe(0);

    await repo.layerDiscard("temp");
    const past = new Date(Date.now() - 2 * 3_600_000);
    for (const id of [cp, state.tree, scratchBlob]) {
      await utimes(repo.objects.shardPath(id), past, past);
    }

    const gc = await repo.gc();
    expect(gc.removed).toBe(3);
    expect(await repo.objects.has(cp)).toBe(false);

    const world = await repo.worldHead();
    const clone = await freshClone(repo, world!);
    expect(await readFile(join(clone, "a.txt"), "utf8")).toBe("a\n");

    const fsck = await repo.fsck();
    expect(fsck.ok).toBe(true);
    expect(fsck.issues).toEqual([]);
    expect(fsck.unreachable).toEqual([]);
  });
});
