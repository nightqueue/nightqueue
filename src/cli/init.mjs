import { UserError } from "../config/errors.mjs";
import { gitPathOrNull, requireGitPath } from "../config/projects.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { importGhConnection } from "./gh-import.mjs";
import { registerProject } from "./project.mjs";
import { INSTALL_OPTIONS, install, installOptions } from "./setup.mjs";

const USAGE =
  "nightshift init [path] [--org <name>] [--name <name>] [--from <dir>] [--path|--no-path] [--embedding|--no-embedding] [--shortcuts|--no-shortcuts] [--gh|--no-gh]";

// Turns the two GitHub CLI flags into the single mode the import understands, refusing the contradictory pair.
function ghMode(values) {
  if (values.gh === true && values["no-gh"] === true) {
    throw new UserError(`\`--gh\` and \`--no-gh\` cannot be used together; usage: ${USAGE}`);
  }
  if (values["no-gh"] === true) return "never";
  return values.gh === true ? "always" : "auto";
}

// Repository to register: an explicit path has to be one, the current directory only is one when it carries a `.git`.
function projectPath(positionals, ctx) {
  if (positionals[0] !== undefined) return requireGitPath(positionals[0]);
  return gitPathOrNull(ctx.cwd ?? ".");
}

// Runs `nightshift init`: installs the runtime, registers it in the host and, inside a repository, registers the project too.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    ...INSTALL_OPTIONS,
    org: { type: "string" },
    name: { type: "string" },
    gh: { type: "boolean" },
    "no-gh": { type: "boolean" },
  });
  checkArgs(positionals, { max: 1, usage: USAGE });
  const mode = ghMode(values);
  const path = projectPath(positionals, ctx);
  await install(ctx, installOptions(values, USAGE));
  if (!path) {
    ctx.out(`no git repository in ${ctx.cwd ?? "."}; run \`nightshift init <path>\` inside one to register a project`);
    return 0;
  }
  const project = registerProject(ctx, { path, name: values.name, org: values.org });
  await importGhConnection(ctx, { mode, org: project.org });
  return 0;
}
