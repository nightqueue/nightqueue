import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store/open.mjs";
import { makeDir, makeHome, makeProject } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));

// An artifact shaped like the one an Explore really writes: responsibilities carrying their own dashes and arrows, a scoped lib, and a prose bullet among the libs.
function exploreArtifact(repo) {
  return `## File map

- ${repo}/src/cli/index.mjs — COMMANDS dispatch map, SELF_LOCKING_COMMANDS, USAGE — the only wiring point for a new subcommand (verify/libs/run → no lock needed)
- ${repo}/src/store/open.mjs — \`openStore(env)\` / \`openStoreReadOnly(env)\` — the ONLY door into SQLite (Decision #15)
- ${repo}/test/store-boundary.test.mjs — greps every \`.mjs\` under \`src/\` for a \`memory/db.mjs\` import and for \`.prepare(\`

## Access map

- explore.md Step 4 · plugin/agents/explore.md:69-76 · read as the agent's system prompt · terminal: command: \`/resolve\`

## Third-party libraries

- @modelcontextprotocol/sdk@1.30.0 (from package-lock.json \`node_modules/@modelcontextprotocol/sdk\`, not the \`^1.30.0\` range)
- zod@4.5.4 (from package-lock.json \`node_modules/zod\`, not the \`^4.5.4\` range in package.json)
- None new required by this task: the new commands parse lockfiles with \`node:fs\`; no existing helper was found in \`src/\`

## Structural index

- Persisted by the runtime from this artifact.
`;
}

// A registered project whose path is the one the child process sees as its cwd, so the fixture is not defeated by the symlinked temp directory of macOS.
function makeRepo(t, env, name) {
  return realpathSync(makeProject(t, env, name));
}

// Writes an artifact in a directory of its own and answers its path.
function writeArtifact(t, name, text) {
  const path = join(makeDir(t, `index-save-${name}`), "02-explore.md");
  writeFileSync(path, text);
  return path;
}

// Runs `nightqueue run index-save` as a real subprocess.
function runIndexSave(env, cwd, args) {
  const result = spawnSync(process.execPath, [CLI, "run", "index-save", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(result.error, undefined, `the CLI failed to spawn: ${result.error}`);
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

test("a real explore artifact is persisted and read back through the store", async (t) => {
  const env = makeHome(t, "index-save");
  const repo = makeRepo(t, env, "alpha");
  const artifact = writeArtifact(t, "valid", exploreArtifact(repo));

  const result = runIndexSave(env, repo, [artifact]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "index saved: 3 files, 2 libs");
  const index = await openStore(env).index.recallProjectIndex({ project: "alpha", repoRoot: repo });
  assert.deepEqual(
    index.files.map((file) => file.path).sort(),
    ["src/cli/index.mjs", "src/store/open.mjs", "test/store-boundary.test.mjs"],
  );
  assert.deepEqual(index.libs.map((lib) => `${lib.lib}@${lib.version}`), [
    "@modelcontextprotocol/sdk@1.30.0",
    "zod@4.5.4",
  ]);
  assert.match(
    index.files.find((file) => file.path === "src/cli/index.mjs").responsibility,
    /^COMMANDS dispatch map, SELF_LOCKING_COMMANDS, USAGE — the only wiring point/,
  );
});

test("a `None ...` prose bullet of the libs section never becomes a lib", async (t) => {
  const env = makeHome(t, "index-save-prose");
  const repo = makeRepo(t, env, "alpha");
  const artifact = writeArtifact(t, "prose", exploreArtifact(repo));

  const result = runIndexSave(env, repo, [artifact]);

  assert.equal(result.stdout, "index saved: 3 files, 2 libs");
  const index = await openStore(env).index.recallProjectIndex({ project: "alpha", repoRoot: repo });
  assert.equal(index.libs.some((lib) => /^None/i.test(lib.lib)), false, JSON.stringify(index.libs));
  assert.equal(result.stderr, "");
});

test("a libs bullet that is neither `<lib>@<version>` nor a `None` note is skipped and named on stderr", (t) => {
  const env = makeHome(t, "index-save-skipped");
  const repo = makeRepo(t, env, "alpha");
  const text = exploreArtifact(repo).replace("- zod@4.5.4 (", "- lodash, whichever version is installed (");
  const artifact = writeArtifact(t, "skipped", text);

  const result = runIndexSave(env, repo, [artifact]);

  assert.equal(result.stdout, "index saved: 3 files, 1 libs");
  assert.match(result.stderr, /not a `<lib>@<version>` entry, skipped: lodash, whichever version is installed/);
});

test("--repo-root and --project index the artifact from any working directory", async (t) => {
  const env = makeHome(t, "index-save-flags");
  const repo = makeRepo(t, env, "alpha");
  const artifact = writeArtifact(t, "flags", exploreArtifact(repo));

  const result = runIndexSave(env, makeDir(t, "index-save-elsewhere"), [artifact, "--project", "alpha", "--repo-root", repo]);

  assert.equal(result.code, 0, result.stderr);
  const index = await openStore(env).index.recallProjectIndex({ project: "alpha", repoRoot: repo });
  assert.equal(index.files.length, 3);
  assert.ok(
    index.files.every((file) => !file.path.startsWith("/")),
    `the paths were not relativised: ${index.files.map((file) => file.path).join(", ")}`,
  );
});

test("`## Libs` is read as the alias of `## Third-party libraries`", async (t) => {
  const env = makeHome(t, "index-save-alias");
  const repo = makeRepo(t, env, "alpha");
  const text = exploreArtifact(repo).replace("## Third-party libraries", "## Libs");
  const artifact = writeArtifact(t, "alias", text);

  const result = runIndexSave(env, repo, [artifact]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "index saved: 3 files, 2 libs");
  const index = await openStore(env).index.recallProjectIndex({ project: "alpha", repoRoot: repo });
  assert.equal(index.libs.length, 2);
});

test("a `None` libs section saves the files and no lib at all", async (t) => {
  const env = makeHome(t, "index-save-none");
  const repo = makeRepo(t, env, "alpha");
  const text = `${exploreArtifact(repo).split("## Third-party libraries")[0]}## Third-party libraries\n\n- None\n`;
  const artifact = writeArtifact(t, "none", text);

  const result = runIndexSave(env, repo, [artifact]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "index saved: 3 files, 0 libs");
  const index = await openStore(env).index.recallProjectIndex({ project: "alpha", repoRoot: repo });
  assert.deepEqual(index.libs, []);
});

test("an artifact with no libs section saves the files and says why no lib was saved", (t) => {
  const env = makeHome(t, "index-save-no-libs");
  const repo = makeRepo(t, env, "alpha");
  const text = exploreArtifact(repo).split("## Third-party libraries")[0];
  const artifact = writeArtifact(t, "no-libs", text);

  const result = runIndexSave(env, repo, [artifact]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "index saved: 3 files, 0 libs");
  assert.match(result.stderr, /no `## Third-party libraries` section/);
});

test("an artifact with no `## File map` section is refused, naming the section", (t) => {
  const env = makeHome(t, "index-save-missing");
  const repo = makeRepo(t, env, "alpha");
  const artifact = writeArtifact(t, "missing", "## Access map\n\n- nothing to index here\n");

  const result = runIndexSave(env, repo, [artifact]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /no `## File map` section; nothing to index/);
  assert.equal(result.stdout, "");
});

test("a `## File map` with no entry is refused instead of saving an empty index", (t) => {
  const env = makeHome(t, "index-save-empty");
  const repo = makeRepo(t, env, "alpha");
  const artifact = writeArtifact(t, "empty", "## File map\n\n## Third-party libraries\n\n- zod@4.5.4\n");

  const result = runIndexSave(env, repo, [artifact]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /carries no `- <path> — <responsibility>` entry/);
});

test("a file-map entry with no ` — ` separator is refused, naming the line", (t) => {
  const env = makeHome(t, "index-save-separator");
  const repo = makeRepo(t, env, "alpha");
  const artifact = writeArtifact(t, "separator", `## File map\n\n- ${repo}/src/cli/index.mjs\n- ${repo}/src/cli/run.mjs — dispatches the run steps\n`);

  const result = runIndexSave(env, repo, [artifact]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /`## File map` line 3 has no ` — ` between the path and its responsibility/);
  assert.match(result.stderr, /src\/cli\/index\.mjs/);
});

test("an artifact path that does not exist is refused by path, before the store is opened", (t) => {
  const env = makeHome(t, "index-save-absent");
  const repo = makeRepo(t, env, "alpha");

  const result = runIndexSave(env, repo, [join(repo, "02-explore.md")]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /artifact not found: /);
});

test("the artifact may live outside the worktree, but a repository root that is not a directory is refused", (t) => {
  const env = makeHome(t, "index-save-boundaries");
  const repo = makeRepo(t, env, "alpha");
  const artifact = writeArtifact(t, "boundaries", exploreArtifact(repo));

  const outsideArtifact = runIndexSave(env, repo, [artifact]);
  const missingRoot = runIndexSave(env, repo, [artifact, "--repo-root", join(repo, "no-such-dir")]);
  const fileAsRoot = runIndexSave(env, repo, [artifact, "--repo-root", artifact]);
  const artifactIsADir = runIndexSave(env, repo, [repo]);

  assert.equal(outsideArtifact.code, 0, "the run directory sits outside the worktree on purpose");
  assert.equal(missingRoot.code, 1);
  assert.match(missingRoot.stderr, /repository root not found: /);
  assert.equal(fileAsRoot.code, 1);
  assert.match(fileAsRoot.stderr, /repository root is not a directory: /);
  assert.equal(artifactIsADir.code, 1);
  assert.match(artifactIsADir.stderr, /artifact is a directory, not a file: /);
});

test("a repository that is not a registered project is refused with the init message", (t) => {
  const env = makeHome(t, "index-save-unregistered");
  const outsider = makeDir(t, "index-save-outsider");
  const artifact = writeArtifact(t, "unregistered", exploreArtifact(outsider));

  const result = runIndexSave(env, outsider, [artifact]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /is not registered; run `nightqueue init` in the repository first/);
});

test("`nightqueue run` lists its subcommands and refuses an unknown one", (t) => {
  const env = makeHome(t, "index-save-steps");
  const cwd = makeDir(t, "index-save-steps-cwd");

  const help = spawnSync(process.execPath, [CLI, "run", "--help"], { cwd, env, encoding: "utf8" });
  const unknown = spawnSync(process.execPath, [CLI, "run", "secrets-swep"], { cwd, env, encoding: "utf8" });

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /subcommands:\n(?:.*\n)*? {2}nightqueue run index-save <artifact>/);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown run subcommand `secrets-swep`; use: check, commit, log, pr, index-save/);
});
