import { createWebServer } from "./server";

function argValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const javelindUrl = argValue("javelind") ?? process.env.JAVELIND_URL ?? "http://localhost:8080";
const port = Number(argValue("port") ?? process.env.WEB_PORT ?? 3000);
const token = argValue("token") ?? process.env.JAVELIN_TOKEN ?? "";

const server = createWebServer({ javelindUrl, port, token: token || undefined });
console.log(`javelin web listening on http://localhost:${server.port} (javelind: ${javelindUrl})`);
