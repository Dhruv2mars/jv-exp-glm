import { resolve } from "node:path";
import { init, openRepository } from "@javelin/vcs";
import {
  diffFileMaps,
  flattenTree,
  formatConflicts,
  formatDiff,
  listLocalContributions,
  resolveAuthor,
} from "./shared";

export async function cmdInit(dir = "."): Promise<string> {
  const root = resolve(process.cwd(), dir);
  const repo = await init(root);
  return `initialized javelin repository in ${root} (world ${await repo.worldHead() ?? "none"})`;
}

export async function cmdStatus(root: string): Promise<string> {
  const repo = await openRepository(root);
  const current = await repo.currentLayer();
  const lines: string[] = [`world: ${await repo.worldHead() ?? "none"}`];
  let compareId = await repo.worldHead();
  if (current === "world") {
    lines.push("on world (run 'javelin layer new <name>' to start tentative work)");
  } else {
    const ref = await repo.layerGet(current);
    if (!ref) throw new Error(`no such layer: ${current}`);
    lines.push(`layer: ${ref.name}`);
    lines.push(`base: ${ref.base}`);
    lines.push(`head: ${ref.head ?? "(no checkpoints)"}`);
    compareId = ref.head ?? ref.base;
  }
  const headFiles = compareId ? await flattenTree(repo, compareId) : {};
  const changes = diffFileMaps(headFiles, await repo.scanWorkingDir());
  if (changes.length === 0) lines.push("working tree clean");
  else {
    lines.push("changes:");
    for (const c of changes) lines.push(`  ${c.status.padEnd(9)} ${c.path}`);
  }
  return lines.join("\n");
}

export async function cmdLayerNew(root: string, name: string): Promise<string> {
  const repo = await openRepository(root);
  const ref = await repo.layerNew(name);
  await repo.layerSwitch(name);
  return `created layer ${ref.name} (base ${ref.base}); switched to it`;
}

export async function cmdLayerList(root: string): Promise<string> {
  const repo = await openRepository(root);
  const current = await repo.currentLayer();
  const layers = await repo.layerList();
  if (layers.length === 0) return "(no layers)";
  return layers
    .map((l) => `${l.name === current ? "* " : "  "}${l.name}  head ${l.head ?? "-"}  base ${l.base}`)
    .join("\n");
}

export async function cmdLayerSwitch(root: string, name: string): Promise<string> {
  const repo = await openRepository(root);
  const target = await repo.layerSwitch(name);
  return typeof target === "string" ? `switched to world` : `switched to layer ${target.name} (head ${target.head ?? "-"})`;
}

export async function cmdLayerDiscard(root: string, name: string): Promise<string> {
  const repo = await openRepository(root);
  await repo.layerDiscard(name);
  return `discarded layer ${name} (world untouched)`;
}

export async function cmdCheckpoint(root: string, message: string): Promise<string> {
  if (!message) throw new Error("checkpoint message required (-m <msg>)");
  const repo = await openRepository(root);
  const { stateId, layer } = await repo.checkpoint({ message, author: resolveAuthor() });
  return `[${layer} ${stateId}] ${message}`;
}

export async function cmdLog(
  root: string,
  opts: { layer?: string; limit?: number } = {},
): Promise<string> {
  const repo = await openRepository(root);
  const limit = opts.limit && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 100;
  const entries = opts.layer ? await repo.layerLog(opts.layer, limit) : await repo.worldLog(limit);
  if (entries.length === 0) return opts.layer ? `no checkpoints on layer ${opts.layer}` : "no published states yet";
  return entries
    .map(
      (e) =>
        `state ${e.id}\nauthor ${e.state.author.name} <${e.state.author.email}> ${e.state.author.time}\n\n    ${e.state.message.split("\n").join("\n    ")}`,
    )
    .join("\n\n");
}

export async function cmdDiff(root: string, againstWorld = false): Promise<string> {
  const repo = await openRepository(root);
  let entries;
  if (againstWorld) {
    const current = await repo.currentLayer();
    if (current === "world") throw new Error("--world diff requires a checked-out layer");
    const ref = await repo.layerGet(current);
    if (!ref?.head) throw new Error(`layer ${current} has no checkpoints`);
    const world = await repo.worldHead();
    entries = diffFileMaps(world ? await flattenTree(repo, world) : {}, await flattenTree(repo, ref.head));
  } else {
    const current = await repo.currentLayer();
    const ref = current === "world" ? null : await repo.layerGet(current);
    const headId = ref ? (ref.head ?? ref.base) : await repo.worldHead();
    const headFiles = headId ? await flattenTree(repo, headId) : {};
    entries = diffFileMaps(headFiles, await repo.scanWorkingDir());
  }
  if (entries.length === 0) return "no changes";
  return formatDiff(entries);
}

export async function cmdRefresh(root: string): Promise<string> {
  const repo = await openRepository(root);
  const current = await repo.currentLayer();
  if (current === "world") throw new Error("refresh requires a checked-out layer");
  const result = await repo.refresh(current);
  if (!result.ok) {
    throw new Error(`refresh failed with ${result.conflicts.length} conflict(s):\n${formatConflicts(result.conflicts)}`);
  }
  if (result.stateId === null) return `layer ${current} already contains the world head`;
  return `refreshed layer ${current} at ${result.stateId}`;
}

export async function cmdContribute(root: string, title?: string): Promise<string> {
  const repo = await openRepository(root);
  const current = await repo.currentLayer();
  if (current === "world") throw new Error("contribute requires a checked-out layer");
  const ref = await repo.layerGet(current);
  if (!ref?.head) throw new Error(`layer ${current} has no checkpoints`);
  const id = await repo.contribute(current, title ?? `publish ${current}`, resolveAuthor());
  return `opened contribution ${id} from layer ${current} (state ${ref.head})`;
}

export async function cmdContributions(root: string, status?: string): Promise<string> {
  if (status !== undefined && !["open", "published", "discarded"].includes(status)) {
    throw new Error(`invalid status: ${status} (open|published|discarded)`);
  }
  const repo = await openRepository(root);
  const all = await listLocalContributions(repo);
  const rows = all
    .filter((c) => status === undefined || c.meta.status === status)
    .map((c) => `${c.meta.status.padEnd(10)} ${c.id}  ${c.contribution.layer}  ${c.contribution.title}`);
  if (rows.length === 0) return status ? `no ${status} contributions` : "(no contributions)";
  return rows.join("\n");
}
