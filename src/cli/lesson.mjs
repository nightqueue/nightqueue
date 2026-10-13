import { UserError } from "../config/errors.mjs";
import { resolveProjectRef } from "../config/projects.mjs";
import { parseRecordId } from "../memory/refs.mjs";
import { refuseMemoryDeleteInsideJob } from "../queue/home-guard.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const DELETE_USAGE = "nightqueue lesson delete <id> [--project <name>]";

// The id of the project `--project` names, or undefined (no ownership check) when the flag is absent.
export async function projectIdOfFlag(store, name) {
  if (name === undefined) return undefined;
  const project = await resolveProjectRef(store, name);
  if (project === null) throw new UserError(`\`--project\` expects a registered project name or key, got \`${name}\``);
  return project.id;
}

// Runs `nightqueue lesson delete <id>`: removes one lesson and its search entry.
async function runDelete(argv, ctx) {
  refuseMemoryDeleteInsideJob(ctx.env, "`nightqueue lesson delete`");
  const { values, positionals } = parseCommand(argv, { project: { type: "string" } });
  checkArgs(positionals, { min: 1, max: 1, usage: DELETE_USAGE });
  const id = parseRecordId(positionals[0], "L");
  const store = openStore(ctx.env);
  const projectId = await projectIdOfFlag(store, values.project);
  const deleted = await store.lessons.deleteLesson({ id, projectId });
  ctx.out(`deleted lesson L${deleted.id}: ${deleted.title}`);
}

const SUBCOMMANDS = new Map([["delete", runDelete]]);

// Dispatches the subcommands of `nightqueue lesson`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown lesson subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
