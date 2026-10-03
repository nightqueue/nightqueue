import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { packageRoot } from "../host/paths.mjs";
import { startStudioServer } from "../studio/server.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { requirePort } from "./mcp.mjs";

const USAGE = "nightqueue studio [--port <n>] [--token <t>] [--api-only] [--dev-origin <url>] [--no-open]";

const OPENERS = { darwin: ["open", []], win32: ["cmd", ["/c", "start", ""]] };

// The token the studio requires, generated only when neither the flag nor the environment gave one.
function resolveToken(values, env) {
  if (values.token !== undefined) {
    if (values.token === "") throw new UserError(`\`--token\` cannot be empty; usage: ${USAGE}`);
    return values.token;
  }
  const fromEnv = env.NIGHTQUEUE_STUDIO_TOKEN;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  return randomBytes(24).toString("hex");
}

// The built pages the studio serves, refused when the dist was never built; the API-only mode serves none.
function resolveDistDir(apiOnly) {
  const distDir = join(packageRoot(), "studio", "dist");
  if (!apiOnly && !existsSync(join(distDir, "index.html"))) {
    throw new UserError("studio/dist is missing — run `npm run studio:build` (a published package ships it)");
  }
  return distDir;
}

// Opens a URL in the default browser, detached; a failure is a warning line, never an exit.
function openBrowser(url, ctx) {
  const [command, prefix] = OPENERS[process.platform] ?? ["xdg-open", []];
  try {
    const child = ctx.spawnImpl(command, [...prefix, url], { detached: true, stdio: "ignore" });
    child.on?.("error", (err) => ctx.err(`studio: could not open a browser (${err?.message ?? String(err)}); open the URL above by hand`));
    child.unref?.();
  } catch (err) {
    ctx.err(`studio: could not open a browser (${err?.message ?? String(err)}); open the URL above by hand`);
  }
}

// Runs `nightqueue studio`: serves the local web cockpit on 127.0.0.1, prints its tokenized URL and opens it unless told not to.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    port: { type: "string" },
    token: { type: "string" },
    "api-only": { type: "boolean" },
    "dev-origin": { type: "string" },
    "no-open": { type: "boolean" },
  });
  checkArgs(positionals, { max: 0, usage: USAGE });
  const apiOnly = values["api-only"] === true;
  if (values["dev-origin"] !== undefined && !apiOnly) throw new UserError(`\`--dev-origin\` only applies with \`--api-only\`; usage: ${USAGE}`);
  const port = requirePort(values.port);
  const token = resolveToken(values, ctx.env);
  const distDir = resolveDistDir(apiOnly);
  const { url } = await startStudioServer({ env: ctx.env, port, token, distDir, apiOnly, devOrigin: values["dev-origin"] ?? null });
  ctx.out(`studio listening on ${url}`);
  if (!apiOnly && values["no-open"] !== true) openBrowser(url, ctx);
}
