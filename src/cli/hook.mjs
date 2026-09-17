import { UserError } from "../config/errors.mjs";
import { runAgentForeground } from "../hooks/agent-foreground.mjs";
import { runPromptContext } from "../hooks/prompt-context.mjs";
import { runReflect } from "../hooks/reflect.mjs";
import { runSessionStart } from "../hooks/session-start.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const STDIN_TIMEOUT_MS = 2000;

const HOOKS = new Map([
  ["session-start", { handler: runSessionStart, fallback: "" }],
  ["prompt-context", { handler: runPromptContext, fallback: "" }],
  ["reflect", { handler: runReflect, fallback: "{}" }],
  ["agent-foreground", { handler: runAgentForeground, fallback: "" }],
]);

// Consumes the whole stdin, giving up on the wait when the host keeps the stream open.
function readAll(stdin, timeoutMs) {
  return new Promise((resolve) => {
    let data = "";
    let timer = null;
    const onData = (chunk) => {
      data += chunk;
    };
    const finish = () => {
      if (timer) clearTimeout(timer);
      stdin.off?.("data", onData);
      stdin.off?.("end", finish);
      stdin.off?.("error", finish);
      stdin.pause?.();
      resolve(data);
    };
    timer = setTimeout(finish, timeoutMs);
    stdin.setEncoding?.("utf8");
    stdin.on("data", onData);
    stdin.once("end", finish);
    stdin.once("error", finish);
  });
}

// Reads the hook event JSON from stdin, tolerating an empty or malformed payload.
async function readStdinJson(stdin, { timeoutMs = STDIN_TIMEOUT_MS } = {}) {
  if (!stdin || typeof stdin.on !== "function") return {};
  try {
    const parsed = JSON.parse(await readAll(stdin, timeoutMs));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Runs a hook, turning any failure into its neutral answer, because a hook must never break the session.
async function safeRun({ handler, fallback }, input, ctx) {
  try {
    return await handler({ input, env: ctx.env, fetchImpl: ctx.fetchImpl });
  } catch (err) {
    ctx.err(`nightshift hook: ${err?.message ?? String(err)}`);
    return fallback;
  }
}

// Dispatches the subcommands of `nightshift hook`, reading the event JSON from stdin.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const hook = HOOKS.get(sub);
  if (!hook) throw new UserError(`unknown hook \`${sub ?? ""}\`; use: ${[...HOOKS.keys()].join(", ")}`);
  checkArgs(parseCommand(rest).positionals, { max: 0, usage: `nightshift hook ${sub}` });
  const input = await readStdinJson(ctx.stdin);
  const output = await safeRun(hook, input, ctx);
  if (output) ctx.out(output);
}
