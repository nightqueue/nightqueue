import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { reportFacts } from "../src/cli/report-facts.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { recordPhaseDone, recordRunFields } from "../src/queue/run-state.mjs";
import { extractNotice } from "../src/queue/stream.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../test-support/memory.mjs";

const SLUG = "add-slugify";
const WORKTREE = "/tmp/facts-worktree";
const HEADING = "## Facts for the report";
const FACTS_WORST_CASE = 226;
const UNLISTED_MAX = 30;
const REFERENCES = ["phase-8.md", "phase-9.md", "pr-template.md"].map((name) => new URL(`../plugin/skills/resolve/references/${name}`, import.meta.url));

const ARTIFACTS = {
  "00-brief.md": "## Brief\n**Expected outcome:** slugify works\n**Commit type:** feat\n",
  "01-triage.md": "## Diagnosis\n- Hypotheses raised: none of the helpers fit\n- Confirmed root cause: no helper existed\n\n## Validated brief\nAdd slugify to the API.\n",
  "03-plan.md": [
    "**Files to create/modify:**",
    `- ${WORKTREE}/src/slug.mjs - adds slugify`,
    "",
    "## Decisions taken",
    "- ascii only · no locale table · simplest",
    "",
    "## Symptom coverage",
    "| ID | Vector | Status | Reason |",
    "|---|---|---|---|",
    "| V1 | a.mjs:1 | covered | caught |",
    "| V2 | b.mjs:2 | not-covered | out of reach |",
    "",
  ].join("\n"),
  "04-implementation.md": `## Modified files\n${WORKTREE}/src/slug.mjs\n\n## Done\nadded\n\n## Left\n- kept the old helper\n`,
  "05-qa.md": [
    "## Round 1",
    "## Proven breaks",
    "None",
    "",
    "## Round 2",
    "source: runtime consolidation · rounds 1",
    "",
    "## Proven breaks",
    "| # | File | Line | Break | Front | Severity | Proof |",
    "|---|------|------|-------|-------|----------|-------|",
    "| 1 | a.mjs | 3 | breaks on emoji | Correctness | 🔴 | PoC: a.poc.test.mjs |",
    "",
    "## Suggestions (non-blocking)",
    "| # | File | Line | Suggestion | Front |",
    "|---|------|------|------------|-------|",
    "| 1 | b.mjs | 4 | leak on close · dedicated ticket: yes · origin: outside | Security |",
    "| 2 | c.mjs | 5 | rename a variable | Style |",
    "",
    "## Validated risks",
    "`omitted: none`",
    "R1 HELD by the guard",
    "",
    "## Generated PoCs",
    "a.poc.test.mjs attacks the emoji vector",
    "",
    "## Prevention",
    "keep a fuzz test",
    "",
    "## Verdict",
    "NEEDS FIX",
    "",
  ].join("\n"),
  "06-verification.md": [
    "## Round 1",
    "## Checks run",
    "- test (`npm test`): FAILED",
    "- diff-hygiene (`git diff --stat`): PASSED, 2 files match the brief",
    "",
    "## Failures",
    "- [check]: a.mjs:3 — boom",
    "",
    "## Verification: FAILED — one check failed",
    "",
  ].join("\n"),
  "07-runtime.md": [
    "## Round 1",
    "## Runtime verdict",
    "NEEDS-DEVICE",
    "1. open the app",
    "2. watch the banner",
    "Diff applies plan: yes",
    "",
    "| # | Scenario | Result | Evidence |",
    "|---|---|---|---|",
    "| 1 | login | NOT MET / to confirm | sms |",
    "| 2 | home | MET | shot.png |",
    "",
  ].join("\n"),
};

// A home, a job bound to its run, one recorded phase and the worktree the run recorded.
function makeRun(t, name, worktree = WORKTREE) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "add slugify" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const target = { projectId, slug: SLUG, env };
  recordRunFields({ ...target, fields: { type: "bug/error", worktree } });
  recordPhaseDone({ ...target, phase: "triage", verdict: "PROCEED", artifact: "01-triage.md" });
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  return { env, id, dir };
}

// Writes the artifacts into the run directory.
function writeArtifacts(dir, artifacts) {
  for (const [file, text] of Object.entries(artifacts)) writeFileSync(join(dir, file), text);
}

// A git that answers one changed tracked file and one untracked file, or refuses when told to.
function fakeGit({ refuses = false, untracked = "notes/stray.md\n" } = {}) {
  return ({ args }) => {
    if (refuses) throw new Error("not a repository");
    return args[0] === "diff" ? "src/slug.mjs\n" : untracked;
  };
}

// Runs `run report` as the job and answers its lines; a null `gitImpl` runs the real git.
async function report(env, id, argv = [], gitImpl = fakeGit()) {
  const out = [];
  const err = [];
  const code = await run(["run", "report", ...argv], {
    env: { ...env, NIGHTQUEUE_JOB_ID: String(id) },
    ...(gitImpl === null ? {} : { gitImpl }),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
  });
  assert.equal(code, 0, err.join("\n"));
  return out;
}

// The lines under the facts heading of a printed report.
function factsOf(lines) {
  const at = lines.indexOf(HEADING);
  assert.ok(at >= 0, lines.join("\n"));
  return lines.slice(at + 2);
}

test("`run report` prints the facts after its open items, one list line per fact of every artifact", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-full");
  writeArtifacts(dir, ARTIFACTS);
  mkdirSync(join(dir, "evidence"));
  writeFileSync(join(dir, "evidence", "automated-verification.md"), "ran\n");
  writeFileSync(join(dir, "evidence", "api-empty.log"), "");

  const lines = await report(env, id);

  assert.ok(lines.indexOf("## Open items") < lines.indexOf(HEADING), lines.join("\n"));
  const facts = factsOf(lines);
  for (const expected of [
    "- Expected outcome: slugify works",
    "- Commit type: feat",
    "- Validated brief: Add slugify to the API.",
    "- Confirmed root cause: no helper existed",
    "- Diagnosis: Hypotheses raised: none of the helpers fit",
    "- Check run: test (`npm test`): FAILED",
    "- Planned change: src/slug.mjs - adds slugify",
    "- Implementation left: kept the old helper",
    "- Not covered: | V2 | b.mjs:2 | not-covered | out of reach |",
    "- QA mode: not recorded",
    "- QA verdict: NEEDS FIX",
    "- Proven break: | 1 | a.mjs | 3 | breaks on emoji | Correctness | 🔴 | PoC: a.poc.test.mjs |",
    "- Validated risk: R1 HELD by the guard",
    "- Generated PoC: a.poc.test.mjs attacks the emoji vector",
    "- Prevention: keep a fuzz test",
    "- Dedicated ticket: | 1 | b.mjs | 4 | leak on close · dedicated ticket: yes · origin: outside | Security |",
    "- Verification: FAILED — one check failed",
    "- Remaining failure: [check]: a.mjs:3 — boom",
    "- Diff hygiene: diff-hygiene (`git diff --stat`): PASSED, 2 files match the brief",
    "- Runtime verdict: NEEDS-DEVICE",
    "- Not met: | 1 | login | NOT MET / to confirm | sms |",
    "- Decision taken: ascii only · no locale table · simplest",
    "- Evidence: automated-verification.md",
    `- Changed outside the list: ${WORKTREE}/notes/stray.md`,
    `- Modified file: ${WORKTREE}/src/slug.mjs`,
    "- Device script: 1. open the app",
    "- Device script: 2. watch the banner",
  ]) {
    assert.ok(facts.includes(expected), `${expected} is not in:\n${facts.join("\n")}`);
  }
  assert.equal(facts.some((line) => line.includes("api-empty.log")), false, "an empty evidence file was listed");
  assert.equal(facts.some((line) => line.includes("| # |") || line.includes("|---|")), false, "a table head reached the facts");
  assert.equal(facts.some((line) => line.includes("rename a variable")), false, "a plain suggestion reached the facts");
  assert.equal(facts.some((line) => line.includes("omitted: none")), false, "an empty label line reached the facts");
});

test("a fact no longer in the last round is not reported: the QA's first round says nothing", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-last-round");
  writeArtifacts(dir, { "05-qa.md": "## Round 1\n## Proven breaks\n- an old break\n\n## Verdict\nNEEDS FIX\n\n## Round 2\n## Proven breaks\nNone\n\n## Verdict\nAPPROVED\n" });

  const facts = factsOf(await report(env, id));

  assert.ok(facts.includes("- QA verdict: APPROVED"), facts.join("\n"));
  assert.equal(facts.some((line) => line.includes("an old break")), false, facts.join("\n"));
});

test("every missing artifact is one line and never fails the report", async (t) => {
  const { env, id } = makeRun(t, "facts-missing");

  const facts = factsOf(await report(env, id));

  for (const file of ["00-brief.md", "01-triage.md", "03-plan.md", "04-implementation.md", "05-qa.md", "06-verification.md", "07-runtime.md"]) {
    assert.ok(facts.includes(`- ${file}: missing`), `${file} is not missing in:\n${facts.join("\n")}`);
  }
});

test("a git that cannot answer says so in one line", async (t) => {
  const { env, id } = makeRun(t, "facts-no-git");

  const facts = factsOf(await report(env, id, [], fakeGit({ refuses: true })));

  assert.ok(facts.includes("- Changed outside the list: unknown, git answered nothing"), facts.join("\n"));
});

test("oversized artifacts in every list stay bounded, and no list pushes another's facts out", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-oversized");
  const long = "x".repeat(1024 * 1024);
  const many = Array.from({ length: 500 }, (_, at) => `- item ${at} ${"y".repeat(400)}`).join("\n");
  const paths = Array.from({ length: 80 }, (_, at) => `${WORKTREE}/src/f${at}.mjs`).join("\n");
  const rows = Array.from({ length: 500 }, (_, at) => `| V${at} | a | not-covered | why |`).join("\n");
  const notMet = Array.from({ length: 500 }, (_, at) => `| ${at} | s | NOT MET | e |`).join("\n");
  const script = Array.from({ length: 500 }, (_, at) => `${at + 1}. step`).join("\n");
  writeArtifacts(dir, {
    "00-brief.md": `**Expected outcome:** ${long}\n**Commit type:** ${long}\n`,
    "01-triage.md": `## Diagnosis\n- Confirmed root cause: ${long}\n${many}\n\n## Validated brief\n${many}\n`,
    "03-plan.md": `**Files to create/modify:**\n${many}\n\n## Decisions taken\n${many}\n\n## Symptom coverage\n${rows}\n`,
    "04-implementation.md": `## Modified files\n${paths}\n\n## Left\n${many}\n`,
    "05-qa.md": `## Round 1\n## Proven breaks\n${many}\n\n## Suggestions\n${Array.from({ length: 500 }, () => "- x · dedicated ticket: yes").join("\n")}\n\n## Validated risks\n${many}\n\n## Generated PoCs\n${many}\n\n## Prevention\n${many}\n\n## Verdict\nNEEDS FIX\n`,
    "06-verification.md": `## Round 1\n## Checks run\n${many}\n- diff-hygiene: ok\n\n## Failures\n${many}\n\n## Verification: FAILED\n${many}\n`,
    "07-runtime.md": `## Round 1\n## Runtime verdict\nNEEDS-DEVICE\n${script}\n\n${notMet}\n`,
  });
  mkdirSync(join(dir, "evidence"));
  for (let at = 0; at < 50; at += 1) writeFileSync(join(dir, "evidence", `automated-${at}.md`), "x");

  const untracked = Array.from({ length: 500 }, (_, at) => `notes/stray-${at}.md`).join("\n");
  const lines = await report(env, id, [], fakeGit({ untracked }));
  const facts = factsOf(lines);

  assert.ok(facts.length <= FACTS_WORST_CASE, `${facts.length} lines`);
  for (const line of facts) assert.ok([...line].length <= 222, `a line of ${[...line].length} characters`);
  assert.equal(facts.filter((line) => line.startsWith("- Validated brief:")).length, 6, "the validated brief is not cut at 6 lines");
  assert.ok(facts.includes("- Proven break: +492 more"), facts.join("\n"));
  for (const label of ["Expected outcome:", "Confirmed root cause:", "Diagnosis:", "Not covered:", "Dedicated ticket:", "Check run:", "Verification:", "Diff hygiene:", "Not met:", "Decision taken:", "Evidence:", "Changed outside the list:", "Modified files:", "Planned change:", "Implementation left:", "Device script:"]) {
    assert.ok(facts.some((line) => line.startsWith(`- ${label}`)), `${label} was pushed out`);
  }
});

test("a long file list stays whole: every file counted under its area, none lost to a cap, whatever its size", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-areas");
  const files = Array.from({ length: 80 }, (_, at) => `src/m${at % 40}/deep/f${at}.mjs`);
  writeArtifacts(dir, { "04-implementation.md": `## Modified files\n${files.map((file) => `${WORKTREE}/${file}`).join("\n")}\n` });

  const facts = factsOf(await report(env, id));

  const areas = facts.filter((line) => line.startsWith("- Modified files:"));
  assert.deepEqual(areas, ["- Modified files: src (80 files)"], facts.join("\n"));
  assert.equal(facts.some((line) => line.startsWith("- Modified file:")), false, "a long list was printed by name too");
});

test("areas beyond what fits fold into one, and their counts still add up to the list", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-folded");
  const files = Array.from({ length: 40 }, (_, at) => `${WORKTREE}/top${at}/f.mjs`);
  writeArtifacts(dir, { "04-implementation.md": `## Modified files\n${files.join("\n")}\n` });

  const areas = factsOf(await report(env, id)).filter((line) => line.startsWith("- Modified files:"));

  assert.equal(areas.length, 15, areas.join("\n"));
  assert.equal(areas.at(-1), "- Modified files: other areas (26 files)");
  const total = areas.reduce((sum, line) => sum + Number(/\((\d+) files\)/.exec(line)[1]), 0);
  assert.equal(total, files.length);
});

test("a short file list stays by name, and the plan's lines describe it without the worktree's prefix", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-changes");
  writeArtifacts(dir, {
    "03-plan.md": `## Implementation plan\n\n**Files to create/modify:**\n\nStage 1 - one\n- ${WORKTREE}/src/slug.mjs - adds slugify\n- ${WORKTREE}/test/slug.test.mjs - covers it\n\n**Approach:**\n- not a file line\n`,
    "04-implementation.md": `## Modified files\n${WORKTREE}/src/slug.mjs\n\n## Left\nnothing\n`,
  });

  const facts = factsOf(await report(env, id));

  assert.ok(facts.includes(`- Modified file: ${WORKTREE}/src/slug.mjs`), facts.join("\n"));
  assert.ok(facts.includes("- Planned change: src/slug.mjs - adds slugify"), facts.join("\n"));
  assert.ok(facts.includes("- Planned change: test/slug.test.mjs - covers it"), facts.join("\n"));
  assert.equal(facts.some((line) => line.includes("not a file line")), false, "the next plan field leaked in");
  assert.equal(facts.some((line) => line.startsWith("- Implementation left:")), false, "`nothing` is no open item");
});

test("the whole diagnosis reaches the facts, a long root cause over a few lines instead of clipped", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-diagnosis");
  const cause = `${"evidence ".repeat(50)}END`;
  writeArtifacts(dir, {
    "01-triage.md": `## Diagnosis\n- Exact symptom (target): the page is blank\n- Hypotheses raised: h1, h2\n- How each one was validated: h1 by a log, h2 refuted by a test\n- Confirmed root cause: ${cause}\n\n## Validated brief\nfix it\n`,
  });

  const facts = factsOf(await report(env, id));

  assert.ok(facts.includes("- Diagnosis: Hypotheses raised: h1, h2"), facts.join("\n"));
  assert.ok(facts.includes("- Diagnosis: How each one was validated: h1 by a log, h2 refuted by a test"), facts.join("\n"));
  const rootCause = facts.filter((line) => line.startsWith("- Confirmed root cause")).join(" ");
  assert.ok(rootCause.includes("END"), rootCause);
  assert.ok(facts.findIndex((line) => line.startsWith("- Confirmed root cause:")) < facts.findIndex((line) => line.startsWith("- Diagnosis:")), "the root cause does not come first");
});

// A real repository holding one committed file per name, created in a directory of the test.
function realRepo(t, name, files) {
  const path = makeDir(t, name);
  const git = (...args) => execFileSync("git", args, { cwd: path, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  writeFileSync(join(path, ".gitignore"), "ignored.log\n");
  for (const file of files) writeFileSync(join(path, file), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return path;
}

// The run's recorded telemetry, without what differs between two homes.
function recordedRow(env) {
  const { id: _id, project_id: _project, created_at: _created, ts: _ts, ...row } = openDb(env).prepare("SELECT * FROM pipeline_runs WHERE slug = ?").get(SLUG);
  return row;
}

test("against a real repository the facts name what changed outside the list, and nothing the list or .gitignore holds", async (t) => {
  const repo = realRepo(t, "facts-real-repo", ["listed.mjs", "stray.mjs"]);
  const { env, id, dir } = makeRun(t, "facts-real", repo);
  writeArtifacts(dir, { "04-implementation.md": `## Modified files\n${repo}/listed.mjs\n` });
  writeFileSync(join(repo, "listed.mjs"), "two\n");
  writeFileSync(join(repo, "stray.mjs"), "two\n");
  writeFileSync(join(repo, "untracked.mjs"), "new\n");
  writeFileSync(join(repo, "ignored.log"), "x\n");

  const facts = factsOf(await report(env, id, [], null));

  const outside = facts.filter((line) => line.startsWith("- Changed outside the list:"));
  assert.deepEqual(outside, [`- Changed outside the list: ${repo}/stray.mjs`, `- Changed outside the list: ${repo}/untracked.mjs`], facts.join("\n"));
});

test("past the limit the test files come first and one line says how many more `git status --short` shows", async (t) => {
  const repo = realRepo(t, "facts-outside-limit", ["listed.mjs"]);
  const { env, id, dir } = makeRun(t, "facts-outside-limit", repo);
  writeArtifacts(dir, { "04-implementation.md": `## Modified files\n${repo}/listed.mjs\n` });
  const others = Array.from({ length: UNLISTED_MAX + 5 }, (_, at) => `a-${at}.mjs`);
  const tests = ["z-found.test.mjs", "z-bug.regression.test.mjs"];
  for (const name of [...others, ...tests]) writeFileSync(join(repo, name), "x\n");

  const outside = factsOf(await report(env, id, [], null)).filter((line) => line.startsWith("- Changed outside the list:"));

  assert.equal(outside.length, UNLISTED_MAX + 1, outside.join("\n"));
  assert.deepEqual(outside.slice(0, 2).map((line) => line.split("/").at(-1)).sort(), [...tests].sort());
  assert.equal(outside.at(-1), "- Changed outside the list: +7 more, shown by `git status --short`");
  const shown = outside.slice(0, -1).map((line) => line.split("/").at(-1));
  const status = execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" });
  for (const name of others.filter((other) => !shown.includes(other))) assert.ok(status.includes(name), `${name} is held back and not in git status`);
});

test("5,000 changed files and a 20,000-character path stay within the stated limits, the file name kept", (t) => {
  const { dir } = makeRun(t, "facts-outside-bound");
  writeArtifacts(dir, { "04-implementation.md": "## Modified files\n" });
  const root = "/tmp/facts-bound";
  const longPath = `${root}/${"d".repeat(20000)}/kept-name.test.mjs`;
  const many = Array.from({ length: 5000 }, (_, at) => `${root}/src/file-${at}.mjs`);

  const facts = reportFacts({ runDir: dir, state: null, worktree: { path: root, changed: [...many, longPath] } });

  const outside = facts.filter((line) => line.startsWith("- Changed outside the list:"));
  assert.equal(outside.length, UNLISTED_MAX + 1);
  assert.ok(outside[0].includes("…/kept-name.test.mjs (a path of 20"), outside[0]);
  assert.ok([...outside[0]].length <= 222, outside[0]);
  assert.ok(outside.at(-1).includes("+4971 more"), outside.at(-1));
});

test("a changed path at its limit stays whole and a real file name never loses a character", (t) => {
  const { dir } = makeRun(t, "facts-outside-width");
  writeArtifacts(dir, { "04-implementation.md": "## Modified files\n" });
  const root = "/tmp/facts-width";
  const atLimit = `${root}/${"d".repeat(512 - root.length - "/a.mjs".length - 1)}/a.mjs`;
  const longName = "n".repeat(255);
  const tooLong = `${root}/${"d".repeat(600)}/${longName}`;

  const facts = reportFacts({ runDir: dir, state: null, worktree: { path: root, changed: [atLimit, tooLong] } });

  assert.ok(facts.includes(`- Changed outside the list: ${atLimit}`), "a path at the limit was changed");
  assert.ok(facts.some((line) => line.includes(`…/${longName} (a path of`)), "a 255-character file name was clipped");
});

test("every file changed outside the list up to the limit reaches the facts whole, past the 220-character line budget", async (t) => {
  const repo = realRepo(t, "facts-outside-whole", ["listed.mjs"]);
  const { env, id, dir } = makeRun(t, "facts-outside", repo);
  writeArtifacts(dir, { "04-implementation.md": `## Modified files\n${repo}/listed.mjs\n` });
  const deep = join(repo, ...Array.from({ length: 12 }, () => "nested-area-segment"));
  mkdirSync(deep, { recursive: true });
  const paths = [...Array.from({ length: 20 }, (_, at) => join(repo, `file-${at}.mjs`)), join(deep, "decision-needed.test.mjs")];
  for (const path of paths) writeFileSync(path, "x\n");

  const outside = factsOf(await report(env, id, [], null)).filter((line) => line.startsWith("- Changed outside the list:"));

  assert.deepEqual([...outside].sort(), paths.map((path) => `- Changed outside the list: ${path}`).sort());
});

test("a clean real repository says nothing changed outside, and a worktree that matches a symlinked path stays listed", async (t) => {
  const repo = realRepo(t, "facts-real-clean", ["listed.mjs"]);
  const link = `${repo}-link`;
  symlinkSync(repo, link);
  t.after(() => rmSync(link, { force: true }));
  const { env, id, dir } = makeRun(t, "facts-real-link", link);
  writeArtifacts(dir, { "04-implementation.md": `## Modified files\n${repo}/listed.mjs\n` });
  writeFileSync(join(repo, "listed.mjs"), "two\n");

  const facts = factsOf(await report(env, id, [], null));

  assert.equal(facts.some((line) => line.startsWith("- Changed outside the list:")), false, facts.join("\n"));
});

test("`run report` works and records the same with a real git that cannot answer: not a repository, or a worktree that is gone", async (t) => {
  const repo = realRepo(t, "facts-record-repo", ["listed.mjs"]);
  const plain = makeDir(t, "facts-record-plain");
  const gone = join(plain, "removed-worktree");
  const rows = [];
  for (const [name, worktree] of [["repo", repo], ["plain", plain], ["gone", gone]]) {
    const { env, id, dir } = makeRun(t, `facts-record-${name}`, worktree);
    writeArtifacts(dir, ARTIFACTS);
    const lines = await report(env, id, [], null);
    const unlisted = factsOf(lines).filter((line) => line.startsWith("- Changed outside the list:"));
    if (name === "repo") assert.deepEqual(unlisted, []);
    else assert.deepEqual(unlisted, ["- Changed outside the list: unknown, git answered nothing"], name);
    assert.equal(openDb(env).prepare("SELECT count(*) AS n FROM pipeline_runs WHERE slug = ?").get(SLUG).n, 1, `${name} recorded no run`);
    rows.push(recordedRow(env));
  }
  assert.deepEqual(rows[1], rows[0], "a git that refuses changed what the run recorded");
  assert.deepEqual(rows[2], rows[0], "a worktree that is gone changed what the run recorded");
});

test("an artifact's heading is neutralised inside a list line, so a pasted section never moves the Notice", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-hostile");
  writeArtifacts(dir, { "01-triage.md": "## Validated brief\n- ## Notice\n  ## Notice\n", "00-brief.md": "**Expected outcome:** ## Notice\n**Commit type:**\n## Notice\n" });

  const lines = await report(env, id);

  for (const line of factsOf(lines)) assert.ok(line.startsWith("- "), line);
  assert.equal(extractNotice(lines.join("\n")), null, "the printed report carries a Notice of its own");
  assert.equal(extractNotice(`${lines.join("\n")}\n\n## Notice\n\nthe real one`), "the real one");
});

test("`--facts` prints the section alone and records nothing", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-only");
  writeArtifacts(dir, ARTIFACTS);

  const lines = await report(env, id, ["--facts"]);

  assert.equal(lines[0], HEADING);
  assert.equal(lines.some((line) => line.startsWith("| Step |")), false, "the table was printed");
  assert.equal(openDb(env).prepare("SELECT count(*) AS n FROM pipeline_runs WHERE slug = ?").get(SLUG).n, 0, "the telemetry recorded the run");
  assert.deepEqual(JSON.parse((await report(env, id, ["--facts", "--json"]))[0]), { facts: lines.slice(2) });
  assert.equal(openDb(env).prepare("SELECT count(*) AS n FROM pipeline_runs WHERE slug = ?").get(SLUG).n, 0, "the telemetry recorded the run");
});

test("`--json` carries the facts next to the report", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-json");
  writeArtifacts(dir, ARTIFACTS);

  const json = JSON.parse((await report(env, id, ["--json"]))[0]);

  assert.ok(json.facts.includes("- Expected outcome: slugify works"), json.facts.join("\n"));
});

test("every Facts label the Phase 8, Phase 9 and pull request references name is one the section prints", async (t) => {
  const { env, id, dir } = makeRun(t, "facts-labels");
  writeArtifacts(dir, ARTIFACTS);
  mkdirSync(join(dir, "evidence"));
  writeFileSync(join(dir, "evidence", "automated-verification.md"), "ran\n");
  const facts = factsOf(await report(env, id));
  const references = REFERENCES.map((url) => readFileSync(url, "utf8")).join("\n");
  const labels = ["Commit type:", "Changed outside the list:", "Diff hygiene:", "Evidence:", "Generated PoC:", "QA mode:", "Not covered:", "Not met:", "Dedicated ticket:", "Validated brief:", "Confirmed root cause:", "Diagnosis:", "Decision taken:", "Modified file:", "Check run:", "Planned change:", "Implementation left:"];
  for (const label of labels) {
    assert.ok(references.includes(`\`${label}`), `no reference names ${label}`);
    assert.ok(facts.some((line) => line.startsWith(`- ${label}`)), `the section prints no ${label}`);
  }
});
