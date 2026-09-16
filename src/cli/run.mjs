import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { parseExploreArtifact } from "./explore-artifact.mjs";
import { realPath } from "./paths.mjs";
import { SECRETS_SWEEP_USAGE, runSecretsSweep } from "./secrets-sweep.mjs";

const INDEX_SAVE_USAGE = "nightshift run index-save <artifact> [--project <name>] [--repo-root <path>]";
const HELP_FLAGS = new Set(["--help", "-h", "help"]);

// What the filesystem says one path really is, `null` when there is nothing there and a named refusal for any other error.
function statOf(path, subject) {
  try {
    return statSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new UserError(`${subject} cannot be read: ${path} (${err?.message ?? String(err)})`);
  }
}

// Absolute path of the artifact, every component of it resolved: the run directory sits outside the worktree on purpose, so the
// boundary here is not the working directory but the kind of path - an existing regular file, never a directory or a device.
function artifactPath(cwd, value) {
  const path = realPath(resolve(cwd, value));
  const stats = statOf(path, "artifact");
  if (!stats) throw new UserError(`artifact not found: ${path}`);
  if (stats.isDirectory()) throw new UserError(`artifact is a directory, not a file: ${path}`);
  if (!stats.isFile()) throw new UserError(`artifact is not a regular file: ${path}`);
  return path;
}

// Absolute path of the repository the index is saved for: an existing directory, which the store then still refuses unless it is a registered project.
function repoRootPath(cwd, value) {
  const path = realPath(resolve(cwd, value ?? "."));
  const stats = statOf(path, "repository root");
  if (!stats) throw new UserError(`repository root not found: ${path}`);
  if (!stats.isDirectory()) throw new UserError(`repository root is not a directory: ${path}`);
  return path;
}

// Reads the artifact, naming the path instead of letting a filesystem error out of the command.
function readArtifact(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") throw new UserError(`artifact not found: ${path}`);
    if (err?.code === "EISDIR") throw new UserError(`artifact is a directory, not a file: ${path}`);
    throw new UserError(`artifact cannot be read: ${path} (${err?.message ?? String(err)})`);
  }
}

// Persists the `## File map` and the `## Third-party libraries` of an explore artifact into the project index.
async function runIndexSave(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { project: { type: "string" }, "repo-root": { type: "string" } });
  const [artifact] = checkArgs(positionals, { min: 1, max: 1, usage: INDEX_SAVE_USAGE });
  const repoRoot = repoRootPath(ctx.cwd, values["repo-root"]);
  const project = values.project ?? repoRoot;
  const parsed = parseExploreArtifact(readArtifact(artifactPath(ctx.cwd, artifact)));
  if (!parsed.libsSection) ctx.err("nightshift run index-save: no `## Third-party libraries` section; no lib was saved");
  for (const line of parsed.ignoredLibs) {
    ctx.err(`nightshift run index-save: not a \`<lib>@<version>\` entry, skipped: ${line}`);
  }
  const saved = await openStore(ctx.env).index.saveProjectIndex({
    project,
    repoRoot,
    files: parsed.files,
    libs: parsed.libs,
  });
  ctx.out(`index saved: ${saved.files} files, ${saved.libs} libs`);
  return 0;
}

const STEPS = new Map([
  ["index-save", { usage: INDEX_SAVE_USAGE, handler: runIndexSave }],
  ["secrets-sweep", { usage: SECRETS_SWEEP_USAGE, handler: runSecretsSweep }],
]);

const USAGE = `usage: nightshift run <step> [options]

steps:
${[...STEPS.values()].map((step) => `  ${step.usage}`).join("\n")}`;

// Dispatches the mechanical steps of `nightshift run`, one handler per step.
export async function run(argv, ctx) {
  const [name, ...rest] = argv;
  if (!name || HELP_FLAGS.has(name)) {
    ctx.out(USAGE);
    return 0;
  }
  const step = STEPS.get(name);
  if (!step) throw new UserError(`unknown run step \`${name}\`; use: ${[...STEPS.keys()].join(", ")}`);
  return await step.handler(rest, ctx);
}
