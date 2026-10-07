import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addJob } from "../../src/memory/jobs.mjs";
import { footerLine, PR_FOOTER, PUBLISHED_BODY_FILE, publishedBodyFile } from "../../src/queue/pr-footer.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const BODY = "## Report\n\nthe thing is done.\n\n";

// A home with one project, a run directory and the agent's body file.
function makeFooterHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const runDir = makeDir(t, `${name}-run`);
  const bodyFile = join(makeDir(t, `${name}-body`), "body.md");
  writeFileSync(bodyFile, BODY);
  return { env, runDir, bodyFile };
}

// The sha-256 of a file, to prove the agent's body was never edited.
function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("the footer is the bare signature", () => {
  assert.equal(PR_FOOTER, "Opened by nightqueue");
});

test("a job publishes a copy ending with the bare signature, the same on a second call, and the agent's file is unchanged", (t) => {
  const { env, runDir, bodyFile } = makeFooterHome(t, "pr-footer-job");
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix it" }, env);
  const before = hashOf(bodyFile);

  const first = publishedBodyFile({ bodyFile, runDir, jobId: job.id });
  const second = publishedBodyFile({ bodyFile, runDir, jobId: job.id });

  assert.equal(first, join(runDir, PUBLISHED_BODY_FILE));
  assert.equal(second, first);
  assert.equal(readFileSync(first, "utf8"), "## Report\n\nthe thing is done.\n\nOpened by nightqueue\n");
  assert.equal(hashOf(bodyFile), before, "the agent's body file was edited");
});

test("a run outside the queue ends with the bare signature too", (t) => {
  const { runDir, bodyFile } = makeFooterHome(t, "pr-footer-outside");
  const published = publishedBodyFile({ bodyFile, runDir, jobId: null });
  assert.equal(readFileSync(published, "utf8"), "## Report\n\nthe thing is done.\n\nOpened by nightqueue\n");
});

test("a job with an origin ends with the signature naming its kind and ref; a partial origin keeps the bare signature", (t) => {
  const { runDir, bodyFile } = makeFooterHome(t, "pr-footer-origin");
  const linear = publishedBodyFile({ bodyFile, runDir, jobId: 4, origin: { kind: "linear", ref: "MK-42" } });
  assert.equal(readFileSync(linear, "utf8"), "## Report\n\nthe thing is done.\n\nOpened by nightqueue · linear MK-42\n");
  const sentry = publishedBodyFile({ bodyFile, runDir, jobId: 4, origin: { kind: "sentry", ref: "4507" } });
  assert.equal(readFileSync(sentry, "utf8"), "## Report\n\nthe thing is done.\n\nOpened by nightqueue · sentry 4507\n");
  assert.equal(footerLine(null), "Opened by nightqueue");
  assert.equal(footerLine({ kind: "linear", ref: "" }), "Opened by nightqueue");
  assert.equal(footerLine({ kind: "", ref: "MK-42" }), "Opened by nightqueue");
});

test("a body that cannot be read refuses the publication, naming the job", (t) => {
  const { runDir } = makeFooterHome(t, "pr-footer-broken");
  assert.throws(() => publishedBodyFile({ bodyFile: join(runDir, "missing.md"), runDir, jobId: 3 }), {
    name: "UserError",
    message: /^could not build the pull request footer from J-3: .*ENOENT.*; nothing was pushed$/,
  });
});
