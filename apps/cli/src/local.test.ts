import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectId, type ObjectId } from "@javelin/protocol";
import { openRepository } from "@javelin/vcs";
import {
  cmdCheckpoint,
  cmdContribute,
  cmdContributions,
  cmdDiff,
  cmdInit,
  cmdLayerDiscard,
  cmdLayerList,
  cmdLayerNew,
  cmdLayerSwitch,
  cmdLog,
  cmdRefresh,
  cmdStatus,
} from "./local";
import { cmdPublish } from "./remote";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "javelin-cli-local-"));
}

function worldHeadOf(status: string): ObjectId {
  return objectId(status.match(/world: ([0-9a-f]{64})/)![1]!);
}

describe("v2 local flow", () => {
  test("init, layer, checkpoint, contribute, publish advances world", async () => {
    const root = tempRepo();
    try {
      expect(await cmdInit(root)).toContain("initialized javelin repository");
      let status = await cmdStatus(root);
      expect(status).toMatch(/world: [0-9a-f]{64}/);
      expect(status).toContain("on world");

      expect(await cmdLayerNew(root, "work")).toContain("created layer work");
      status = await cmdStatus(root);
      expect(status).toContain("layer: work");
      expect(status).toContain("head: (no checkpoints)");

      writeFileSync(join(root, "a.txt"), "alpha\n");
      const checkpoint = await cmdCheckpoint(root, "first checkpoint");
      expect(checkpoint).toMatch(/\[work [0-9a-f]{64}\]/);
      expect(await cmdStatus(root)).toContain("working tree clean");

      const layerLog = await cmdLog(root, { layer: "work", limit: 10 });
      expect(layerLog).toContain("first checkpoint");
      expect(layerLog).toMatch(/state [0-9a-f]{64}/);

      const opened = await cmdContribute(root, "add alpha");
      expect(opened).toMatch(/opened contribution [0-9a-f]{64} from layer work/);
      const id = opened.match(/[0-9a-f]{64}/)![0];
      expect(await cmdContributions(root)).toContain(id);
      expect(await cmdContributions(root, "open")).toContain("add alpha");

      const worldBefore = worldHeadOf(await cmdStatus(root));
      expect(await cmdPublish(root, id)).toContain("published");
      const worldAfter = worldHeadOf(await cmdStatus(root));
      expect(worldAfter).not.toBe(worldBefore);

      const worldLog = await cmdLog(root, { limit: 10 });
      expect(worldLog).toContain("publish work: add alpha");
      expect(await cmdContributions(root, "published")).toContain(id);
      expect(await cmdContributions(root, "open")).toContain("no open contributions");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status and diff report modified, added, and deleted files", async () => {
    const root = tempRepo();
    try {
      await cmdInit(root);
      await cmdLayerNew(root, "work");
      writeFileSync(join(root, "keep.txt"), "keep\n");
      writeFileSync(join(root, "gone.txt"), "gone\n");
      await cmdCheckpoint(root, "base files");

      writeFileSync(join(root, "keep.txt"), "keep v2\n");
      writeFileSync(join(root, "new.txt"), "new\n");
      rmSync(join(root, "gone.txt"));
      const status = await cmdStatus(root);
      expect(status).toMatch(/modified\s+keep\.txt/);
      expect(status).toMatch(/added\s+new\.txt/);
      expect(status).toMatch(/deleted\s+gone\.txt/);
      const diff = await cmdDiff(root);
      expect(diff).toMatch(/modified\s+keep\.txt/);
      expect(diff).toMatch(/deleted\s+gone\.txt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("layer switch materializes and prunes files, preserving modes and bytes", async () => {
    const root = tempRepo();
    try {
      await cmdInit(root);
      await cmdLayerNew(root, "one");
      writeFileSync(join(root, "shared.txt"), "from one\n");
      const bin = Uint8Array.from([0x00, 0x80, 0xff, 0x00, 0x80, 0xff]);
      writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho hi\n");
      chmodSync(join(root, "run.sh"), 0o755);
      writeFileSync(join(root, "blob.bin"), bin);
      await cmdCheckpoint(root, "one");
      await cmdPublish(root, (await cmdContribute(root, "one")).match(/[0-9a-f]{64}/)![0]);

      await cmdLayerNew(root, "two");
      await cmdLayerSwitch(root, "two");
      expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("from one\n");
      writeFileSync(join(root, "only-two.txt"), "two\n");
      await cmdCheckpoint(root, "two");

      await cmdLayerSwitch(root, "one");
      expect(existsSync(join(root, "only-two.txt"))).toBe(false);
      expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("from one\n");
      expect(Buffer.compare(readFileSync(join(root, "blob.bin")), Buffer.from(bin))).toBe(0);
      expect(await cmdLayerList(root)).toContain("* one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discard removes the layer and leaves the world untouched", async () => {
    const root = tempRepo();
    try {
      await cmdInit(root);
      await cmdLayerNew(root, "temp");
      writeFileSync(join(root, "x.txt"), "x\n");
      await cmdCheckpoint(root, "tentative");
      const worldBefore = worldHeadOf(await cmdStatus(root));

      expect(await cmdLayerDiscard(root, "temp")).toContain("discarded layer temp");
      expect(await cmdLayerList(root)).not.toContain("temp");
      const repo = await openRepository(root);
      expect(await repo.worldHead()).toBe(worldBefore);
      expect(await repo.currentLayer()).toBe("world");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refresh integrates world changes into a layer across different files", async () => {
    const root = tempRepo();
    try {
      await cmdInit(root);
      await cmdLayerNew(root, "one");
      writeFileSync(join(root, "a.txt"), "one\n");
      await cmdCheckpoint(root, "a file");
      await cmdPublish(root, (await cmdContribute(root, "a file")).match(/[0-9a-f]{64}/)![0]);

      await cmdLayerNew(root, "two");
      await cmdLayerSwitch(root, "two");
      writeFileSync(join(root, "b.txt"), "b\n");
      await cmdCheckpoint(root, "b file");

      await cmdLayerNew(root, "three");
      await cmdLayerSwitch(root, "three");
      writeFileSync(join(root, "a.txt"), "one-v3\n");
      await cmdCheckpoint(root, "a file v3");
      await cmdPublish(root, (await cmdContribute(root, "a file v3")).match(/[0-9a-f]{64}/)![0]);

      await cmdLayerSwitch(root, "two");
      const refreshed = await cmdRefresh(root);
      expect(refreshed).toMatch(/refreshed layer two at [0-9a-f]{64}/);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one-v3\n");
      expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refresh reports structured conflicts and writes nothing", async () => {
    const root = tempRepo();
    try {
      await cmdInit(root);
      await cmdLayerNew(root, "seed");
      writeFileSync(join(root, "f.txt"), "line\n");
      await cmdCheckpoint(root, "seed");
      await cmdPublish(root, (await cmdContribute(root, "seed")).match(/[0-9a-f]{64}/)![0]);

      await cmdLayerNew(root, "x");
      await cmdLayerSwitch(root, "x");
      writeFileSync(join(root, "f.txt"), "x-line\n");
      await cmdCheckpoint(root, "x edit");

      await cmdLayerNew(root, "y");
      await cmdLayerSwitch(root, "y");
      writeFileSync(join(root, "f.txt"), "y-line\n");
      await cmdCheckpoint(root, "y edit");

      await cmdLayerSwitch(root, "x");
      await cmdPublish(root, (await cmdContribute(root, "x edit")).match(/[0-9a-f]{64}/)![0]);

      await cmdLayerSwitch(root, "y");
      expect(cmdRefresh(root)).rejects.toThrow(/conflict: f.txt \(content\)/);
      expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("y-line\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("publish reports merge conflicts against the world instead of writing", async () => {
    const root = tempRepo();
    try {
      await cmdInit(root);
      await cmdLayerNew(root, "seed");
      writeFileSync(join(root, "f.txt"), "line\n");
      await cmdCheckpoint(root, "seed");

      await cmdLayerNew(root, "x");
      await cmdLayerSwitch(root, "x");
      writeFileSync(join(root, "f.txt"), "x-line\n");
      await cmdCheckpoint(root, "x edit");

      await cmdLayerNew(root, "y");
      await cmdLayerSwitch(root, "y");
      writeFileSync(join(root, "f.txt"), "y-line\n");
      await cmdCheckpoint(root, "y edit");

      await cmdLayerSwitch(root, "x");
      await cmdPublish(root, (await cmdContribute(root, "x edit")).match(/[0-9a-f]{64}/)![0]);
      await cmdLayerSwitch(root, "y");

      const id = (await cmdContribute(root, "y edit")).match(/[0-9a-f]{64}/)![0];
      expect(cmdPublish(root, id)).rejects.toThrow(/conflict: f.txt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
