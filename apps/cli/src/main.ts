import { resolve } from "node:path";
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
import { cmdClone, cmdFetch, cmdPublish, cmdPull, cmdPush, cmdRemoteAdd } from "./remote";

interface ParsedArgs {
  positional: string[];
  options: Map<string, string>;
}

function parseArgs(args: string[], flags: string[], booleanFlags: string[] = []): ParsedArgs {
  const isBoolean = (name: string) => booleanFlags.some((b) => b.replace(/^-+/, "") === name.replace(/^-+/, ""));
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.replace(/^-+/, "");
    const flag = flags.find((f) => f.replace(/^-+/, "") === name);
    if (flag) {
      if (isBoolean(flag)) {
        options.set(name, "true");
        continue;
      }
      const value = args[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      options.set(name, value);
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function usage(): string {
  return `usage: javelin <command> [args]

commands:
  init [dir]                      create a new repository
  status                          world head, current layer, changed files
  layer new <name>                fork a layer from the current world head
  layer list                      list layers
  layer switch <name>             materialize a layer (or "world") into the working dir
  layer discard <name>            drop a layer's tentative line; world is untouched
  checkpoint -m <msg>             capture the working dir onto the current layer
  log [--layer <name>] [--limit N]
                                  world history, or one layer's checkpoints
  diff [--world]                  working dir vs layer head, or layer head vs world head
  refresh                         integrate the world into the current layer
  contribute [-t <title>]         open a contribution from the current layer head
  contributions [--status <s>]    list local contributions (open|published|discarded)
  publish <id> [<remote>]         publish a contribution (via remote if configured, else local)
  remote add <name> <url> [--token T]
  fetch [<remote>]                download remote objects; update remote-tracking meta
  pull [<remote>]                 fetch, fast-forward world, refresh the current layer
  clone <url> [<dir>]             clone a remote repository
  push [<remote>]                 upload objects, layers, and contribution status`;
}

type Command = (args: string[], cwd: string) => Promise<string>;

function requirePositional(value: string | undefined, usageLine: string): string {
  if (!value) throw new Error(usageLine);
  return value;
}

const commands: Record<string, Command> = {
  init: async (args) => cmdInit(parseArgs(args, []).positional[0] ?? "."),
  status: async (_args, cwd) => cmdStatus(cwd),
  layer: async (args, cwd) => {
    const [sub, ...rest] = args;
    switch (sub) {
      case "new":
        return cmdLayerNew(cwd, requirePositional(parseArgs(rest, []).positional[0], "usage: javelin layer new <name>"));
      case "list":
        return cmdLayerList(cwd);
      case "switch":
        return cmdLayerSwitch(cwd, requirePositional(parseArgs(rest, []).positional[0], "usage: javelin layer switch <name>"));
      case "discard":
        return cmdLayerDiscard(cwd, requirePositional(parseArgs(rest, []).positional[0], "usage: javelin layer discard <name>"));
      default:
        throw new Error("usage: javelin layer <new|list|switch|discard> ...");
    }
  },
  checkpoint: async (args, cwd) => {
    const { options } = parseArgs(args, ["-m", "--message"]);
    return cmdCheckpoint(cwd, options.get("m") ?? options.get("message") ?? "");
  },
  log: async (args, cwd) => {
    const { options } = parseArgs(args, ["--layer", "--limit"]);
    const limit = options.has("limit") ? Number(options.get("limit")) : undefined;
    return cmdLog(cwd, { layer: options.get("layer"), limit });
  },
  diff: async (args, cwd) => {
    const { options } = parseArgs(args, ["--world"], ["--world"]);
    return cmdDiff(cwd, options.has("world"));
  },
  refresh: async (_args, cwd) => cmdRefresh(cwd),
  contribute: async (args, cwd) => {
    const { options } = parseArgs(args, ["-t", "--title"]);
    return cmdContribute(cwd, options.get("t") ?? options.get("title"));
  },
  contributions: async (args, cwd) => {
    const { options } = parseArgs(args, ["--status"]);
    return cmdContributions(cwd, options.get("status"));
  },
  publish: async (args, cwd) => {
    const { positional } = parseArgs(args, []);
    const id = requirePositional(positional[0], "usage: javelin publish <contributionId> [<remote>]");
    return cmdPublish(cwd, id, positional[1]);
  },
  remote: async (args, cwd) => {
    const { positional, options } = parseArgs(args, ["--token"]);
    if (positional[0] !== "add") throw new Error("usage: javelin remote add <name> <url> [--token T]");
    const [, name, url] = positional;
    if (!name || !url) throw new Error("usage: javelin remote add <name> <url> [--token T]");
    return cmdRemoteAdd(cwd, name, url, options.get("token"));
  },
  fetch: async (args, cwd) => cmdFetch(cwd, parseArgs(args, []).positional[0] ?? "origin"),
  pull: async (args, cwd) => cmdPull(cwd, parseArgs(args, []).positional[0] ?? "origin"),
  push: async (args, cwd) => cmdPush(cwd, parseArgs(args, []).positional[0] ?? "origin"),
  clone: async (args) => {
    const { positional } = parseArgs(args, []);
    const url = requirePositional(positional[0], "usage: javelin clone <url> [<dir>]");
    return cmdClone(url, positional[1]);
  },
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage() + "\n");
    process.exit(command ? 0 : 1);
  }
  const handler = commands[command];
  if (!handler) {
    process.stderr.write(`unknown command: ${command}\n\n${usage()}\n`);
    process.exit(1);
  }
  try {
    const message = await handler(args, resolve(process.cwd()));
    process.stdout.write(message + "\n");
  } catch (e) {
    process.stderr.write(`javelin: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

await main();
