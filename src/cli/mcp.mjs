import { randomBytes } from "node:crypto";
import { UserError } from "../config/errors.mjs";
import { DEFAULT_HTTP_PORT, startHttpServer } from "../mcp/transports/http.mjs";
import { startStdioServer } from "../mcp/transports/stdio.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = "nightqueue mcp [--http] [--port <n>] [--token <t>]";

// The port the http transport binds, where `0` asks the operating system for a free one.
function requirePort(raw) {
  if (raw === undefined) return DEFAULT_HTTP_PORT;
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    throw new UserError(`\`--port\` expects an integer between 0 and 65535, got \`${raw}\``);
  }
  return Number(raw);
}

// The token the http transport requires, generated only when neither the flag nor the environment gave one.
function resolveToken(values, env) {
  if (values.token !== undefined) {
    if (values.token === "") throw new UserError(`\`--token\` cannot be empty; usage: ${USAGE}`);
    return { token: values.token, generated: false };
  }
  const fromEnv = env.NIGHTQUEUE_MCP_TOKEN;
  if (typeof fromEnv === "string" && fromEnv !== "") return { token: fromEnv, generated: false };
  return { token: randomBytes(24).toString("hex"), generated: true };
}

// Serves the tools over Streamable HTTP, printing the generated token first and the listening line last.
async function startHttp(values, ctx) {
  const port = requirePort(values.port);
  const { token, generated } = resolveToken(values, ctx.env);
  const { url } = await startHttpServer({ env: ctx.env, port, token });
  if (generated) ctx.out(`mcp http token: ${token}`);
  ctx.out(`mcp http listening on ${url}`);
}

// Runs `nightqueue mcp`: the stdio server by default, writing nothing but the protocol to stdout.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    http: { type: "boolean" },
    port: { type: "string" },
    token: { type: "string" },
  });
  checkArgs(positionals, { max: 0, usage: USAGE });
  if (values.http === true) {
    await startHttp(values, ctx);
    return;
  }
  if (values.port !== undefined || values.token !== undefined) {
    throw new UserError(`\`--port\` and \`--token\` only apply with \`--http\`; usage: ${USAGE}`);
  }
  await startStdioServer(ctx.env);
}
