import { UserError } from "../config/errors.mjs";
import { listSessions, readSession, refuseOpenSession, removeSession, sessionState, transcriptPath } from "../sessions/registry.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = "nightqueue sessions list [--json] | show <id> [--json] | rm <id>";
const JSON_OPTION = { json: { type: "boolean" } };

// One session as the listing and `show --json` print it: the record plus its derived state and transcript.
function sessionView(record, ctx) {
  return { ...record, state: sessionState(record, { env: ctx.env, killImpl: ctx.killImpl }), transcript: transcriptPath(record, ctx.env) };
}

// One line of the listing.
function sessionLine(view) {
  const project = view.project?.name ?? "no project";
  return `${view.id} · ${view.state} · agent ${view.agent ?? "none"} · ${project} · ${view.cwd} · ${view.updatedAt}`;
}

// The views of the listed sessions, warning about and skipping each one whose state cannot be read.
function listedViews(sessions, ctx) {
  const views = [];
  for (const record of sessions) {
    try {
      views.push(sessionView(record, ctx));
    } catch (err) {
      ctx.err(`nightqueue sessions: warning: ${err?.message ?? String(err)}`);
    }
  }
  return views;
}

// Prints every recorded chat session, newest first, warning about each record that cannot be read.
function listCommand(rest, ctx) {
  const { values, positionals } = parseCommand(rest, JSON_OPTION);
  checkArgs(positionals, { max: 0, usage: USAGE });
  const { sessions, broken } = listSessions(ctx.env);
  for (const entry of broken) ctx.err(`nightqueue sessions: warning: ${entry.error}`);
  const views = listedViews(sessions, ctx);
  if (values.json) return ctx.out(JSON.stringify(views, null, 2));
  if (views.length === 0) return ctx.out("no chat sessions; start one with `nightqueue chat [agent]`");
  for (const view of views) ctx.out(sessionLine(view));
}

// Prints one session's record, its state, transcript and the command that resumes it.
function showCommand(rest, ctx) {
  const { values, positionals } = parseCommand(rest, JSON_OPTION);
  const [id] = checkArgs(positionals, { min: 1, usage: USAGE });
  const view = sessionView(readSession(id, ctx.env), ctx);
  if (values.json) return ctx.out(JSON.stringify(view, null, 2));
  const lines = [
    ["id", view.id],
    ["state", view.state],
    ["agent", view.agent ? `${view.agent} (${view.agentSource})` : "none"],
    ["project", view.project ? `${view.project.name} (${view.project.id})` : "none"],
    ["cwd", view.cwd],
    ["worktree", view.worktree ?? "none"],
    ["claude session", view.claudeSessionId],
    ["transcript", view.transcript ?? "none yet"],
    ["created", view.createdAt],
    ["updated", view.updatedAt],
    ["resume", `nightqueue chat --resume ${view.id}`],
  ];
  for (const [label, value] of lines) ctx.out(`${label}: ${value}`);
}

// Deletes one session's record, refusing a session still open; its worktree and transcript are kept.
function rmCommand(rest, ctx) {
  const { positionals } = parseCommand(rest);
  const [id] = checkArgs(positionals, { min: 1, usage: USAGE });
  const record = readSession(id, ctx.env);
  refuseOpenSession(record, { env: ctx.env, killImpl: ctx.killImpl, action: "removing it" });
  removeSession(id, ctx.env);
  ctx.out(`removed session ${id} (its record only; its worktree and Claude transcript are kept)`);
}

const SUBCOMMANDS = new Map([
  ["list", listCommand],
  ["show", showCommand],
  ["rm", rmCommand],
]);

// Dispatches `nightqueue sessions list|show|rm`.
export function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) throw new UserError(`unknown sessions subcommand \`${sub ?? ""}\`; usage: ${USAGE}`);
  return handler(rest, ctx) ?? 0;
}
