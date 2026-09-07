import { UserError } from "../config/errors.mjs";
import { requireGitPath } from "../config/projects.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { importGhConnection } from "./gh-import.mjs";
import { registerProject } from "./project.mjs";
import { install } from "./setup.mjs";

const USAGE = "shift init [path] [--org <name>] [--name <name>] [--no-model] [--gh|--no-gh]";

// Turns the two GitHub CLI flags into the single mode the import understands, refusing the contradictory pair.
function ghMode(values) {
  if (values.gh === true && values["no-gh"] === true) {
    throw new UserError(`\`--gh\` and \`--no-gh\` cannot be used together; usage: ${USAGE}`);
  }
  if (values["no-gh"] === true) return "never";
  return values.gh === true ? "always" : "auto";
}

// Runs `shift init`: sets the host up, registers the repository as a project and offers the token of the GitHub CLI.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    org: { type: "string" },
    name: { type: "string" },
    "no-model": { type: "boolean" },
    gh: { type: "boolean" },
    "no-gh": { type: "boolean" },
  });
  checkArgs(positionals, { max: 1, usage: USAGE });
  const mode = ghMode(values);
  const path = requireGitPath(positionals[0] ?? ctx.cwd ?? ".");
  await install(ctx, { noModel: values["no-model"] === true });
  const project = registerProject(ctx, { path, name: values.name, org: values.org });
  await importGhConnection(ctx, { mode, org: project.org });
  return 0;
}
