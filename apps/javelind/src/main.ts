import { createServer } from "./server";

function argValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const port = Number(argValue("port") ?? process.env.JAVELIND_PORT ?? 8080);
const root = argValue("root") ?? process.env.JAVELIND_ROOT ?? "./javelind-data";
const token = argValue("token") ?? process.env.JAVELIND_TOKEN ?? "";

const server = createServer({ port, root, token: token || undefined });
console.log(`javelind listening on http://localhost:${server.port} (root: ${root}, auth: ${token ? "on" : "off"})`);
