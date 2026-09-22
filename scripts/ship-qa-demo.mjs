#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeThrowawayHome } from "../src/cli/throwaway-home.mjs";
import { repoSlugOf } from "../src/config/projects.mjs";
import { openStore } from "../src/store/open.mjs";

export const DEMO_REMOTE = "maykonVinicius/nstest-demo";
export const DEFAULT_DEMO_CHECKOUT = "~/Dev/nstest-demo";
export const JOB_IDENTITY_VARS = ["NIGHTSHIFT_JOB_ID", "NIGHTSHIFT_JOB_HOME", "NIGHTSHIFT_JOB_CLAUDE_DIR"];
export const REFUSAL_EXIT = 2;

const CLI = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "bin", "nightshift.mjs");
const PROJECT = "nstest-demo";
const SEED_WORKER = "ship-qa-demo:seed";
const READY_POLLS = 10;
const READY_POLL_MS = 3000;
const CHECKS_TIMEOUT_MS = 600000;

// The refusal of a start inside an unattended nightshift run, or null in the operator's own shell; it never unsets anything.
export function jobIdentityRefusal(env) {
  const present = JOB_IDENTITY_VARS.filter((name) => typeof env?.[name] === "string" && env[name].trim() !== "");
  if (!present.length) return null;
  return `ship-qa-demo refuses to start inside a nightshift job (${present.join(", ")} set): operator-run acceptance: run it from your own terminal. It never unsets a nightshift variable.`;
}

// The refusal of a checkout whose origin is not the nstest-demo remote, or null when it is.
export function demoOriginRefusal(repoPath, options = {}) {
  const slug = repoSlugOf({ path: repoPath }, options);
  if (slug === DEMO_REMOTE.toLowerCase()) return null;
  return `ship-qa-demo refuses to run against ${repoPath}: its origin is ${slug ?? "unreadable"}, not ${DEMO_REMOTE}; real pull request QA runs only on nstest-demo.`;
}

// The options of the script: the demo checkout and its base branch.
function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, options: { repo: { type: "string" }, base: { type: "string" } }, strict: true });
  return { repo: resolve(values.repo ?? DEFAULT_DEMO_CHECKOUT), base: values.base ?? "main" };
}

// Runs a command and answers its exit code and output, never throwing.
function exec(command, args, { cwd = tmpdir(), env = process.env } = {}) {
  const ran = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: CHECKS_TIMEOUT_MS });
  return { code: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? ran.error?.message ?? "" };
}

// Runs a command that must succeed, throwing its output when it does not.
function must(command, args, options) {
  const ran = exec(command, args, options);
  if (ran.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${ran.code}): ${ran.stderr.trim() || ran.stdout.trim()}`);
  return ran;
}

// Runs this checkout's nightshift CLI against the throwaway home, printing the command and its output.
function nightshift(ctx, args) {
  console.log(`\n$ nightshift ${args.join(" ")}`);
  const ran = exec(process.execPath, [CLI, ...args], { cwd: ctx.repo, env: ctx.env });
  const output = `${ran.stdout}${ran.stderr}`;
  process.stdout.write(output);
  return { code: ran.code, output };
}

// Commits one scratch file on a new branch from the base in a throwaway worktree and pushes it.
function pushScratchBranch(ctx, branch) {
  const dir = mkdtempSync(join(tmpdir(), "ship-qa-author-"));
  try {
    must("git", ["-C", ctx.repo, "worktree", "add", "-b", branch, dir, `origin/${ctx.base}`]);
    ctx.branches.push(branch);
    writeFileSync(join(dir, `ship-qa-${branch.replaceAll("/", "-")}.txt`), `${branch}\n`);
    must("git", ["-C", dir, "add", "-A"]);
    must("git", ["-C", dir, "commit", "-m", `ship QA: ${branch}`]);
    must("git", ["-C", dir, "push", "-u", "origin", branch]);
  } finally {
    exec("git", ["-C", ctx.repo, "worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Waits for the checks of a pull request and for GitHub to compute its mergeability.
async function waitUntilReady(url) {
  exec("gh", ["pr", "checks", url, "--watch"]);
  for (let poll = 0; poll < READY_POLLS; poll += 1) {
    const mergeable = exec("gh", ["pr", "view", url, "--json", "mergeable", "-q", ".mergeable"]).stdout.trim();
    if (mergeable && mergeable !== "UNKNOWN") return;
    await sleep(READY_POLL_MS);
  }
}

// Opens a scratch pull request on nstest-demo from a new branch and answers its URL once it is ready to ship.
async function openScratchPr(ctx, branch) {
  pushScratchBranch(ctx, branch);
  const body = "Scratch pull request of nightshift's scripts/ship-qa-demo.mjs; merged or closed by the script.";
  const created = must("gh", ["pr", "create", "--repo", DEMO_REMOTE, "--head", branch, "--base", ctx.base, "--title", `ship QA ${branch}`, "--body", body]);
  const url = created.stdout.trim().split("\n").pop();
  ctx.prs.push(url);
  console.log(`opened ${url} on ${branch}`);
  await waitUntilReady(url);
  return url;
}

// Seeds a `done` job of nstest-demo carrying a pull request and a recorded branch, through the store only.
async function seedDoneJob(ctx, { prUrl, branch }) {
  const jobs = ctx.store.jobs;
  const { id } = await jobs.addJob({ project: PROJECT, prompt: `ship QA of ${prUrl}` });
  if (!(await jobs.claimJobById(id, { worker: SEED_WORKER, cap: null }))) throw new Error(`could not claim the seeded job ${id}`);
  await jobs.persistRunFacts(id, { worker: SEED_WORKER, slug: `ship-qa-${id}`, branch });
  const finished = await jobs.finishJob(id, { worker: SEED_WORKER, status: "done", prUrl, noticeMd: `Seeded by ship-qa-demo for ${prUrl}` });
  if (!finished) throw new Error(`could not finish the seeded job ${id} as done`);
  return id;
}

// The state GitHub reports for a pull request.
function prState(url) {
  return exec("gh", ["pr", "view", url, "--json", "state", "-q", ".state"]).stdout.trim();
}

// The note a step left in a job's ship checklist.
async function stepNote(ctx, id, step) {
  const row = await ctx.store.jobs.getJob(id);
  return JSON.parse(row?.ship ?? "{}")?.steps?.[step]?.note ?? "no note";
}

// A scenario result.
function outcome(name, pass, detail) {
  return { name, pass: Boolean(pass), detail };
}

// Scenario (i): a job's own pull request is squash-merged and the job closes with its Shipped line.
async function realMerge(ctx) {
  const branch = `qa/ship-merge-${ctx.stamp}`;
  const id = await seedDoneJob(ctx, { prUrl: await openScratchPr(ctx, branch), branch });
  const ran = nightshift(ctx, ["queue", "ship", String(id), "--foreground"]);
  const row = await ctx.store.jobs.getJob(id);
  const pass = ran.code === 0 && row.status === "closed" && /Shipped: PR #\d+ merged as/.test(row.notice_md ?? "");
  if (pass) ctx.shippedJob = id;
  return outcome("(i) real merge", pass, `exit ${ran.code}, job ${row.status}`);
}

// Scenario (ii): the base moves ahead after the pull request opened; records which path the conflict step took.
async function trivialRebase(ctx) {
  const branch = `qa/ship-rebase-${ctx.stamp}`;
  const prUrl = await openScratchPr(ctx, branch);
  const advance = await openScratchPr(ctx, `qa/ship-advance-${ctx.stamp}`);
  must("gh", ["pr", "merge", advance, "--squash"]);
  await waitUntilReady(prUrl);
  const id = await seedDoneJob(ctx, { prUrl, branch });
  const ran = nightshift(ctx, ["queue", "ship", String(id), "--foreground"]);
  return outcome("(ii) trivial rebase", ran.code === 0, `exit ${ran.code}; conflict step: ${await stepNote(ctx, id, "conflict")}`);
}

// Runs a foreground ship and interrupts it with SIGINT as soon as its preflight step is recorded done.
function shipInterruptedAfterPreflight(ctx, id) {
  console.log(`\n$ nightshift queue ship ${id} --foreground   (SIGINT after preflight)`);
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, "queue", "ship", String(id), "--foreground"], { cwd: ctx.repo, env: ctx.env });
    const state = { output: "", interrupted: false };
    const onData = (chunk) => {
      state.output += chunk;
      process.stdout.write(chunk);
      if (state.interrupted || !/^✓ preflight/m.test(state.output)) return;
      state.interrupted = true;
      child.kill("SIGINT");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => done({ code: 1, ...state, output: `${state.output}${err.message}` }));
    child.on("close", (code) => done({ code: code ?? 1, ...state }));
  });
}

// Scenario (iii): an interrupted ship resumes from its checklist, the preflight step not redone.
async function resumeAfterInterrupt(ctx) {
  const branch = `qa/ship-resume-${ctx.stamp}`;
  const id = await seedDoneJob(ctx, { prUrl: await openScratchPr(ctx, branch), branch });
  const first = await shipInterruptedAfterPreflight(ctx, id);
  const second = nightshift(ctx, ["queue", "ship", String(id), "--foreground"]);
  const resumed = /^✓ preflight\s.*\(earlier attempt\)$/m.test(second.output);
  const pass = first.interrupted && first.code !== 0 && second.code === 0 && resumed;
  return outcome("(iii) resume after interrupt", pass, `first exit ${first.code} (interrupted: ${first.interrupted}), second exit ${second.code}, preflight resumed: ${resumed}`);
}

// Scenario (iv): a second ship of a shipped job is refused.
async function secondShipRefused(ctx) {
  if (!ctx.shippedJob) return outcome("(iv) second ship refused", false, "scenario (i) shipped no job");
  const ran = nightshift(ctx, ["queue", "ship", String(ctx.shippedJob), "--foreground"]);
  return outcome("(iv) second ship refused", ran.code !== 0 && /already shipped and closed/.test(ran.output), `exit ${ran.code}`);
}

// Scenario (v): a pull request on another branch than the job's is refused, then shipped with --force.
async function foreignBranchGuard(ctx) {
  const prUrl = await openScratchPr(ctx, `qa/ship-foreign-${ctx.stamp}`);
  const id = await seedDoneJob(ctx, { prUrl, branch: `worktree-feat+ship-qa-own-${ctx.stamp}` });
  const refused = nightshift(ctx, ["queue", "ship", String(id), "--foreground"]);
  const stillOpen = prState(prUrl) === "OPEN";
  const forced = nightshift(ctx, ["queue", "ship", String(id), "--foreground", "--force"]);
  const pass = refused.code !== 0 && /pr-not-the-job-branch/.test(refused.output) && stillOpen && forced.code === 0 && /attribution overridden with --force/.test(forced.output);
  return outcome("(v) PR not the job's branch, then --force", pass, `refused exit ${refused.code} (PR still open: ${stillOpen}), forced exit ${forced.code}`);
}

// Runs one scenario, turning a throw into a failed result.
async function attempt(name, scenario, ctx) {
  try {
    return await scenario(ctx);
  } catch (err) {
    return outcome(name, false, err?.message ?? String(err));
  }
}

// Closes every scratch pull request still open, deletes the scratch branches and prunes the worktrees; each part best-effort.
function cleanUp(ctx) {
  for (const url of ctx.prs) if (prState(url) === "OPEN") exec("gh", ["pr", "close", url]);
  for (const branch of ctx.branches) {
    exec("git", ["-C", ctx.repo, "push", "origin", "--delete", branch]);
    exec("git", ["-C", ctx.repo, "branch", "-D", branch]);
  }
  exec("git", ["-C", ctx.repo, "worktree", "prune"]);
}

// Registers nstest-demo in the throwaway home and opens its store.
function registerDemo(ctx) {
  must("git", ["-C", ctx.repo, "fetch", "origin"]);
  const added = nightshift(ctx, ["project", "add", ctx.repo, "--name", PROJECT]);
  if (added.code !== 0) throw new Error(`nstest-demo could not be registered in the throwaway home: ${added.output.trim()}`);
  ctx.store = openStore(ctx.env);
}

// Builds the throwaway home with nstest-demo registered and answers the context every scenario reads; a failed build removes the home.
function prepare(options, env) {
  const home = makeThrowawayHome("nightshift-ship-qa-");
  const ctx = { ...options, home, env: { ...env, ...home.env }, stamp: new Date().toISOString().replace(/\D/g, "").slice(0, 14), branches: [], prs: [], shippedJob: null };
  try {
    registerDemo(ctx);
    return ctx;
  } catch (err) {
    home.remove();
    throw err;
  }
}

// Runs the five scenarios in a throwaway home and always cleans up after them.
async function runScenarios(options, env) {
  const ctx = prepare(options, env);
  try {
    return [
      await attempt("(i) real merge", realMerge, ctx),
      await attempt("(ii) trivial rebase", trivialRebase, ctx),
      await attempt("(iii) resume after interrupt", resumeAfterInterrupt, ctx),
      await attempt("(iv) second ship refused", secondShipRefused, ctx),
      await attempt("(v) PR not the job's branch, then --force", foreignBranchGuard, ctx),
    ];
  } finally {
    cleanUp(ctx);
    ctx.home.remove();
  }
}

// Prints the pass/fail table of the scenarios.
function printTable(results) {
  const width = Math.max(...results.map((result) => result.name.length));
  console.log("\n| scenario | result | detail |\n|---|---|---|");
  for (const result of results) console.log(`| ${result.name.padEnd(width)} | ${result.pass ? "PASS" : "FAIL"} | ${result.detail.replaceAll("|", "\\|")} |`);
}

// Runs the acceptance: both guards first, then the scenarios; answers the exit code.
export async function main(argv = process.argv.slice(2), env = process.env) {
  const jobRefusal = jobIdentityRefusal(env);
  if (jobRefusal) {
    console.error(jobRefusal);
    return REFUSAL_EXIT;
  }
  const options = parseOptions(argv);
  const originRefusal = demoOriginRefusal(options.repo);
  if (originRefusal) {
    console.error(originRefusal);
    return REFUSAL_EXIT;
  }
  const results = await runScenarios(options, env);
  printTable(results);
  return results.every((result) => result.pass) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`ship-qa-demo: ${err?.message ?? String(err)}`);
      process.exitCode = 1;
    },
  );
}
