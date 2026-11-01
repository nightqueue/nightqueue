import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../../src/cli/index.mjs";
import { jobLogPath, logsDir, runDir } from "../../src/config/paths.mjs";
import { withProviders } from "../../src/integrations/registry.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob } from "../../src/memory/jobs.mjs";
import { runClosePipeline } from "../../src/queue/close.mjs";
import { isUnpinnedLine, withoutUnpinnedLine, withUnpinnedLine } from "../../src/queue/pipeline-version.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { DISABLED_BACKGROUND_ESCAPE_LINE, runOwnNotice, withoutRuntimeAppendedLines } from "../../src/queue/run-notice.mjs";
import { recordPhaseDone, recordPipelineUnpinned, recordRunFields } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { jobDetailView } from "../../src/queue/view.mjs";
import { KEPT_PREFIX } from "../../src/queue/worktree.mjs";
import { openStore, withReadOnlyStore } from "../../src/store/open.mjs";
import { ensureProject, makeDir, makeHome, makeProject, projectIdOf, registerCheckout, seedDoneJob } from "../../test-support/memory.mjs";
import { bindTrackerConnection, setIntegrations, trackerProvider, TRACKER_URL } from "../../test-support/origin-provider.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, gateStream, recordedGate, SLUG } from "../../test-support/streams.mjs";
import { git, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const REASON = "the plugin manifest could not be read";
const LINE = `Pipeline version: this run recorded none (${REASON}), so a later pipeline update will not gate it.`;
const MARKED = { pipelineUnpinned: { reason: REASON, at: "2026-01-01T00:00:00Z" } };
const OWN_ALIKE = "Pipeline version: the 0.7 release changes how phases are numbered.";
const CLOSE_WORKER = "close:test:1:unpinned";

// A plugin directory, with a manifest declaring the version when one is given.
function pluginEnv(t, env, name, version = null) {
  const dir = makeDir(t, `${name}-plugin`);
  if (version !== null) {
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "nightqueue", version }));
  }
  return { ...env, NIGHTQUEUE_PLUGIN_DIR: dir };
}

// Runs `run start` through the real CLI, answering what it wrote to stderr.
async function runStart(env) {
  const err = [];
  const io = { env, cwd: process.cwd(), out: () => {}, err: (line) => err.push(line), stdout: { write: () => {} } };
  await run(["run", "start", "--project", "alpha", "--slug", SLUG], io);
  return err;
}

// A home with a project and a run of it.
function startFixture(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return { env, projectId: ensureProject(env, "alpha") };
}

test("`run start` with an unreadable manifest marks the run and still says so on stderr; a later readable start pins it and drops the mark", async (t) => {
  const { env, projectId } = startFixture(t, "unpinned-start");

  const err = await runStart(pluginEnv(t, env, "unpinned-start-broken"));

  assert.ok(err.includes(`nightqueue: the pipeline version was not recorded on the run: ${REASON}`), err.join("\n"));
  const marked = readRunState({ projectId, slug: SLUG, env });
  assert.equal(marked.pipelineUnpinned.reason, REASON);
  assert.equal(marked.pipeline, undefined);

  await runStart(pluginEnv(t, env, "unpinned-start-good", "0.7.0"));

  const pinned = readRunState({ projectId, slug: SLUG, env });
  assert.equal(pinned.pipeline.version, "0.7.0");
  assert.equal(pinned.pipelineUnpinned, undefined);
  assert.equal(withUnpinnedLine("the notice", pinned), "the notice");
});

test("a state that already records a version is never marked", (t) => {
  const { env, projectId } = startFixture(t, "unpinned-recorded");
  const target = { projectId, slug: SLUG, env };
  const statePath = join(env.NIGHTQUEUE_HOME, "runs", projectId, SLUG);
  mkdirSync(statePath, { recursive: true });
  writeFileSync(join(statePath, "state.json"), JSON.stringify({ pipeline: { name: "resolve", version: "0.7.0" } }));

  assert.equal(recordPipelineUnpinned({ ...target, reason: REASON }).status, "unchanged");
  assert.equal(readRunState(target).pipelineUnpinned, undefined);
});

test("a state with phases and no mark gets no line, and the mark gives exactly one", (t) => {
  const { env, projectId } = startFixture(t, "unpinned-line");
  const target = { projectId, slug: SLUG, env };
  assert.equal(recordPhaseDone({ ...target, phase: "triage" }).status, "written");
  assert.equal(withUnpinnedLine("the notice", readRunState(target)), "the notice");

  const marked = { pipelineUnpinned: { reason: REASON, at: "2026-01-01T00:00:00Z" } };
  assert.equal(withUnpinnedLine("the notice", marked), `the notice\n\n${LINE}`);
  assert.equal(withUnpinnedLine(withUnpinnedLine("the notice", marked), marked), `the notice\n\n${LINE}`);
  assert.equal(withUnpinnedLine(null, marked), LINE);
  assert.equal(withoutUnpinnedLine(`the notice\n\n${LINE}`, marked), "the notice");
  assert.equal(withoutUnpinnedLine(null, marked), null);
});

test("with no mark the exact line stays in the row, and a state that is not an object is no mark", () => {
  for (const state of [undefined, null, {}, { pipelineUnpinned: { reason: " " } }, { pipelineUnpinned: "x" }]) {
    assert.equal(withoutUnpinnedLine(`the notice\n\n${LINE}`, state), `the notice\n\n${LINE}`);
  }
});

test("under the mark a run's own paragraph that starts alike stays, anywhere in the notice, while the exact line goes", () => {
  const notice = `${OWN_ALIKE}\n\nthe notice\n\n${LINE}\n\n${OWN_ALIKE}`;

  assert.equal(withoutUnpinnedLine(notice, MARKED), `${OWN_ALIKE}\n\nthe notice\n\n${OWN_ALIKE}`);
  assert.equal(runOwnNotice(`the notice\n\n${OWN_ALIKE}\n\n${LINE}`, MARKED), `the notice\n\n${OWN_ALIKE}`);
});

test("only the whole line counts as the runtime's", () => {
  assert.equal(isUnpinnedLine(LINE), true);
  for (const paragraph of [OWN_ALIKE, `${LINE} And more.`, `Note: ${LINE}`, `Pipeline version: this run recorded none (a\nb), so a later pipeline update will not gate it.`, null]) {
    assert.equal(isUnpinnedLine(paragraph), false, String(paragraph));
  }
});

test("two reasons across attempts leave one line, the latest", () => {
  const second = withUnpinnedLine(withUnpinnedLine("the notice", MARKED), { pipelineUnpinned: { reason: "the state refused the write" } });

  assert.equal(second, "the notice\n\nPipeline version: this run recorded none (the state refused the write), so a later pipeline update will not gate it.");
});

test("a reason holding a newline still builds one line, which the next attempt recognises", () => {
  const state = { pipelineUnpinned: { reason: "first\n\nsecond" } };

  const once = withUnpinnedLine("the notice", state);

  assert.equal(once, "the notice\n\nPipeline version: this run recorded none (first second), so a later pipeline update will not gate it.");
  assert.equal(isUnpinnedLine(once.split("\n\n")[1]), true);
  assert.equal(withUnpinnedLine(once, state), once);
});

test("the views obey the mark: an exact-shape paragraph stays without it, and goes with it", () => {
  for (const state of [{}, null]) {
    assert.equal(runOwnNotice(`the notice\n\n${LINE}`, state), `the notice\n\n${LINE}`);
    assert.equal(withoutRuntimeAppendedLines(`the notice\n\n${LINE}`, state), `the notice\n\n${LINE}`);
  }
  assert.equal(runOwnNotice(`the notice\n\n${LINE}`, MARKED), "the notice");
  assert.equal(withoutRuntimeAppendedLines(`the notice\n\n${LINE}`, MARKED), "the notice");
});

test("a trailing kept line, unpinned line and escape line all strip under the mark", () => {
  const kept = `${KEPT_PREFIX}/tmp/wt - it has uncommitted changes.`;

  assert.equal(runOwnNotice(`the notice\n\n${kept}\n\n${LINE}\n\n${DISABLED_BACKGROUND_ESCAPE_LINE}`, MARKED), "the notice");
});

test("no production caller reads a notice view with no state", () => {
  for (const file of ["close.mjs", "view.mjs", "run-notice.mjs"]) {
    const source = readFileSync(new URL(`../../src/queue/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(runOwnNotice|noChangeConclusion|withoutRuntimeAppendedLines)\([^,)]*\)/, file);
  }
});

// A done job with a run log and a row notice, whose state carries the given content.
function jobWithState(t, name, { runNotice, rowNotice, state }) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  mkdirSync(logsDir(env), { recursive: true });
  const logPath = jobLogPath(id, env);
  writeFileSync(logPath, doneStream({ notice: runNotice }));
  openDb(env).prepare("UPDATE jobs SET status = 'done', slug = ?, notice_md = ?, result = ? WHERE id = ?").run(SLUG, rowNotice, JSON.stringify({ logPath }), id);
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return { env, id };
}

test("jobDetailView sets the exact line aside only under the mark", async (t) => {
  const seed = { runNotice: "the notice", rowNotice: `the notice\n\n${LINE}` };
  const marked = jobWithState(t, "unpinned-detail-marked", { ...seed, state: MARKED });
  const unmarked = jobWithState(t, "unpinned-detail-unmarked", { ...seed, state: {} });

  const markedView = await withReadOnlyStore(marked.env, (store) => jobDetailView(store, marked.id, { env: marked.env }));
  const unmarkedView = await withReadOnlyStore(unmarked.env, (store) => jobDetailView(store, unmarked.id, { env: unmarked.env }));

  assert.equal("run_notice" in markedView, false);
  assert.equal(unmarkedView.run_notice, "the notice");
});

// The conclusions a close tells the origins of a no-change job whose row notice and state are given.
async function conclusionsOf(t, name, { noticeMd, state }) {
  const seen = [];
  const remember = async ({ result }) => {
    seen.push(result.conclusion);
    return { status: "done", note: "told" };
  };
  await withProviders([{ ...trackerProvider(), onClosed: remember, log: remember }], async () => {
    const env = makeHome(t, name);
    const checkout = makeProject(t, env, "alpha");
    const projectId = projectIdOf(env, "alpha");
    const id = seedDoneJob(env, { prompt: `see ${TRACKER_URL}`, prUrl: null, noticeMd });
    openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
    const dir = runDir(projectId, SLUG, env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    bindTrackerConnection(env, projectId);
    setIntegrations(env, projectId, { tracker: { log: { connection: "trk" } } });
    assert.ok(acquireClose(id, { worker: CLOSE_WORKER, leaseS: 660 }, env), "the close lease was refused");
    await runClosePipeline({ store: openStore(env), job: getJob(id, env), worker: CLOSE_WORKER, env, deps: {}, timeoutS: 60, checkout });
  });
  return seen;
}

test("a close tells the origins the run's text and drops the exact line only under the mark", async (t) => {
  const noticeMd = `The loop comes from the CDN.\n\n${LINE}`;

  const marked = await conclusionsOf(t, "unpinned-close-marked", { noticeMd, state: MARKED });
  const unmarked = await conclusionsOf(t, "unpinned-close-unmarked", { noticeMd, state: {} });

  assert.deepEqual(marked, ["The loop comes from the CDN.", "The loop comes from the CDN."]);
  assert.deepEqual(unmarked, [noticeMd, noticeMd]);
});

test("the line is the runtime's own: origins are never told it", () => {
  assert.equal(runOwnNotice(`the notice\n\n${LINE}`), "the notice");
  assert.equal(withoutRuntimeAppendedLines(`the notice\n\n${LINE}`), "the notice");
});

test("`run_set` refuses both new runtime keys", (t) => {
  const { env, projectId } = startFixture(t, "unpinned-run-set");
  for (const name of ["freshRetry", "pipelineUnpinned", "freshRetry.jobId"]) {
    assert.equal(recordRunFields({ projectId, slug: SLUG, fields: { [name]: "x" }, env }).status, "kept", name);
  }
});

test("two attempts in a row with a kept worktree leave exactly one kept line and one unpinned line", async (t) => {
  const { checkout } = publishedCheckout(t, "unpinned-two-attempts");
  const env = { ...makeHome(t, "unpinned-two-attempts"), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  useFakeClaude(env, makeDir(t, "unpinned-two-attempts-plan"), [
    { stdout: gateStream(), runState: recordedGate(), exitCode: 0 },
    { stdout: gateStream(), runState: recordedGate(), exitCode: 0 },
  ]);
  const adopted = join(makeDir(t, "unpinned-two-attempts-linked"), "wt");
  git(["-C", checkout, "worktree", "add", "-q", "-b", "feat/mine", adopted, "main"]);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", startWorktree: adopted }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  assert.equal(recordPipelineUnpinned({ projectId, slug: SLUG, reason: REASON, env }).status, "written");

  await runCycle({ jobId: id, env });
  const first = getJob(id, env);
  assert.equal(first.status, "gate", first.notice_md);
  await applyRetry({ id, note: "go on", env });
  await runCycle({ jobId: id, env });

  const notice = getJob(id, env).notice_md;
  assert.equal(notice.split("\n").filter((line) => line.startsWith("Pipeline version: ")).length, 1, notice);
  assert.equal(notice.split("\n").filter((line) => line.startsWith("Worktree kept: ")).length, 1, notice);
  assert.ok(notice.includes(LINE), notice);
});
