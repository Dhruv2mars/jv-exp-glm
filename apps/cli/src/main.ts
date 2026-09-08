import { resolve } from "node:path";
import { cmdAdd, cmdBranch, cmdCheckout, cmdCommit, cmdDiff, cmdInit, cmdLog, cmdMerge, cmdStatus } from "./local";
import { cmdClone, cmdFetch, cmdPull, cmdPush, cmdRemoteAdd } from "./remote";

interface ParsedArgs {
  positional: string[];
  options: Map<string, string>;
}

function parseArgs(args: string[], flags: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.replace(/^-+/, "");
    const flag = flags.find((f) => f.replace(/^-+/, "") === name);
    if (flag) {
      const value = args[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      options.set(flag.replace(/^-+/, ""), value);
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
  status                          show branch, staged and untracked files
  add <paths...>                  stage files
  commit -m <msg>                 commit the staged index
  log [--limit N]                 show commit history
  diff [<ref>]                    diff index against HEAD, or ref against HEAD
  branch [name]                   list branches, or create one
  checkout <ref>                  switch branches or restore a commit
  merge <ref>                     merge a branch into the current branch
  remote add <name> <url> [--token T]
  push [<remote>] [<branch>]      upload objects and update the remote ref
  fetch [<remote>]                download objects and update remote-tracking refs
  pull [<remote>] [<branch>]      fetch then merge the remote branch
  clone <url> [<dir>]             clone a remote repository`;
}

type Command = (args: string[], cwd: string) => Promise<string>;

const commands: Record<string, Command> = {
  init: async (args) => {
    const { positional } = parseArgs(args, []);
    return cmdInit(positional[0] ?? ".");
  },
  status: async (_args, cwd) => cmdStatus(cwd),
  add: async (args, cwd) => {
    const { positional } = parseArgs(args, []);
    return cmdAdd(cwd, positional);
  },
  commit: async (args, cwd) => {
    const { options } = parseArgs(args, ["-m", "--message"]);
    const message = options.get("m") ?? options.get("message");
    return cmdCommit(cwd, message ?? "");
  },
  log: async (args, cwd) => {
    const { options } = parseArgs(args, ["--limit"]);
    return cmdLog(cwd, Number(options.get("limit") ?? 100));
  },
  diff: async (args, cwd) => {
    const { positional } = parseArgs(args, []);
    return cmdDiff(cwd, positional[0]);
  },
  branch: async (args, cwd) => {
    const { positional } = parseArgs(args, []);
    return cmdBranch(cwd, positional[0]);
  },
  checkout: async (args, cwd) => {
    const { positional } = parseArgs(args, []);
    const target = positional[0];
    if (!target) throw new Error("checkout requires a ref");
    return cmdCheckout(cwd, target);
  },
  merge: async (args, cwd) => {
    const { positional } = parseArgs(args, []);
    const ref = positional[0];
    if (!ref) throw new Error("merge requires a ref");
    return cmdMerge(cwd, ref);
  },
  remote: async (args, cwd) => {
    const { positional, options } = parseArgs(args, ["--token"]);
    if (positional[0] !== "add") throw new Error("usage: javelin remote add <name> <url> [--token T]");
    const [, name, url] = positional;
    if (!name || !url) throw new Error("usage: javelin remote add <name> <url> [--token T]");
    return cmdRemoteAdd(cwd, name, url, options.get("token"));
  },
  push: async (args, cwd) => {
    const { positional } = parseArgs(args, []);
    return cmdPush(cwd, positional[0] ?? "origin", positional[1]);
  },
  fetch: async (args, cwd) => {
    const { positional } = parseArgs(args, []);
    return cmdFetch(cwd, positional[0] ?? "origin");
  },
  pull: async (args, cwd) => {
    const { positional } = parseArgs(args, []);
    return cmdPull(cwd, positional[0] ?? "origin", positional[1]);
  },
  clone: async (args) => {
    const { positional } = parseArgs(args, []);
    const url = positional[0];
    if (!url) throw new Error("usage: javelin clone <url> [<dir>]");
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
