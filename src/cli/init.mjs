import { readFileSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { homeDir, resolvedRuntimeDir, runtimeDir, shimNames, shimPath } from "../config/paths.mjs";
import { gitPathOrNull, requireGitPath } from "../config/projects.mjs";
import { packageVersion, shimState } from "../host/runtime.mjs";
import { pathBlock, rcFilePath } from "../host/shell.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { importGhConnection } from "./gh-import.mjs";
import { guardIdleRuntime } from "./install-guard.mjs";
import { setupEmbedding, setupPath, setupRuntime, setupShim, verifyShim } from "./install-steps.mjs";
import { registerProject } from "./project.mjs";
import { firstLine, makeReport } from "./report.mjs";
import { INSTALL_OPTIONS, finish, installOptions, registerHostServices, setupHome } from "./setup.mjs";

const USAGE =
  "nightshift init [path] [--org <name>] [--name <name>] [--from <dir>] [--force] [--path|--no-path] [--embedding|--no-embedding] [--shortcuts|--no-shortcuts] [--desktop|--no-desktop] [--gh|--no-gh] [--verbose]";

const SOURCE_HINT = "Open a new terminal or run `source ~/.zshrc` (or your shell's rc) to use `nightshift`.";

const FIRST_STEP_REGISTERED =
  'In Claude Code, plan as usual, then say "queue this for tonight" or run /nightshift:queue.';

const FIRST_STEP_UNREGISTERED =
  'cd into a repository and run `nightshift queue add "<task>"` - it offers to register the project on the spot. In Claude Code, plan as usual and say "queue this for tonight" or run /nightshift:queue.';

const NEXT_STEPS = [
  'When you leave, say "run the queue" or run `nightshift queue run` - every queued job runs unattended and opens a pull request.',
  'Come back to `nightshift queue status` and review the PRs; a job waiting at the gate is answered with `nightshift queue retry <id> --note "..."`.',
];

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

// Stops the whole init the moment a step the installation cannot work without has failed.
function requireStep(ok, label) {
  if (ok === true) return;
  throw new UserError(`the \`${label}\` step failed; fix it and run \`nightshift init\` again`);
}

// Creates the configuration home, turning an I/O failure into a failed step instead of a stack trace.
function createHome(ctx, report) {
  try {
    setupHome(ctx, report);
    return true;
  } catch (err) {
    report.degrade("home", firstLine(err?.message ?? String(err)), `mkdir -p ${homeDir(ctx.env)}`);
    return false;
  }
}

// Writes the shims and answers whether the canonical command really ended up on disk, current and executable.
function installShims(ctx, report, { shortcuts }) {
  setupShim(ctx, report, { shortcuts });
  const state = shimState(ctx.env);
  return state.present && state.current && state.executable;
}

// Puts the shim directory on the PATH and answers whether the rc file could be written; a skipped step is a choice, never a failure.
async function installPath(ctx, report, { path }) {
  const degraded = report.count();
  await setupPath(ctx, report, { path });
  return report.count() === degraded;
}

// Tells whether the rc file carries our PATH block, the only case where opening a new terminal is what makes the command resolve.
function rcCarriesBlock(env) {
  try {
    return readFileSync(rcFilePath(env), "utf8").includes(pathBlock(env));
  } catch {
    return false;
  }
}

// Prints what the installation left on disk and what the user still has to do to type `nightshift`.
function printInstalled(ctx, report, { shortcuts }) {
  report.note(`installed nightshift v${packageVersion()} in ${resolvedRuntimeDir(ctx.env) ?? runtimeDir(ctx.env)}`);
  report.note(`commands: ${shimNames({ shortcuts }).map((name) => shimPath(ctx.env, name)).join(", ")}`);
  if (!rcCarriesBlock(ctx.env)) return;
  report.note(`PATH block written to ${rcFilePath(ctx.env)}:`);
  for (const line of pathBlock(ctx.env).split("\n")) report.note(`  ${line}`);
  report.note(SOURCE_HINT);
}

// Prints what to do with the installation; the first step is the one command that fits a run that registered a repository, or one that did not.
function printNextSteps(ctx, { registered } = {}) {
  const steps = [registered === true ? FIRST_STEP_REGISTERED : FIRST_STEP_UNREGISTERED, ...NEXT_STEPS];
  ctx.out("Next steps:");
  for (const [index, step] of steps.entries()) ctx.out(`  ${index + 1}. ${step}`);
}

// Runs the steps of `nightshift init` in order: every step the runtime cannot work without stops the command, and the PATH is only written once the shim has proven itself.
async function runInstallSteps(ctx, report, { embedding, path, from, force, shortcuts, desktop } = {}) {
  guardIdleRuntime(ctx, { force });
  requireStep(createHome(ctx, report), "home");
  requireStep(setupRuntime(ctx, report, { from }), "runtime");
  requireStep(installShims(ctx, report, { shortcuts }), "shim");
  requireStep(verifyShim(ctx, report), "runtime check");
  registerHostServices(ctx, report, { desktop });
  requireStep(await installPath(ctx, report, { path }), "PATH");
  await setupEmbedding(ctx, report, { embedding });
  if (report.quiet()) ctx.out(`host already installed (v${packageVersion()}) - nothing to do`);
  else printInstalled(ctx, report, { shortcuts });
  return finish(ctx, report);
}

// Installs the host for `nightshift init`: a step that fails, however it fails, still prints every step held back so far as the diagnosis.
async function installForInit(ctx, { verbose, ...options } = {}) {
  const report = makeReport(ctx, { collapse: verbose !== true });
  try {
    return await runInstallSteps(ctx, report, options);
  } catch (err) {
    report.flush();
    throw err;
  }
}

// Registers the repository of this run and offers it the token of the GitHub CLI, the part of init that only a repository gets.
async function registerHere(ctx, { path, name, org, mode }) {
  const project = registerProject(ctx, { path, name, org });
  await importGhConnection(ctx, { mode, org: project.org });
}

// Runs `nightshift init`: installs the runtime, registers it in the host and, inside a repository, registers the project too.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    ...INSTALL_OPTIONS,
    org: { type: "string" },
    name: { type: "string" },
    gh: { type: "boolean" },
    "no-gh": { type: "boolean" },
    verbose: { type: "boolean" },
  });
  checkArgs(positionals, { max: 1, usage: USAGE });
  const mode = ghMode(values);
  const path = projectPath(positionals, ctx);
  await installForInit(ctx, { ...installOptions(values, USAGE), verbose: values.verbose === true });
  if (path) await registerHere(ctx, { path, name: values.name, org: values.org, mode });
  printNextSteps(ctx, { registered: Boolean(path) });
  return 0;
}
