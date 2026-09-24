import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEMO_REMOTE, demoOriginRefusal, jobIdentityRefusal, REFUSAL_EXIT } from "../scripts/close-qa-demo.mjs";
import { makeDir } from "../test-support/memory.mjs";
import { git } from "../test-support/worktrees.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/close-qa-demo.mjs", import.meta.url));
const JOB_REFUSAL = /refuses to start inside a nightqueue job .*operator-run acceptance: run it from your own terminal/;

// A local git repository whose origin is the given URL; nothing is fetched or pushed.
function repoWithOrigin(t, name, origin) {
  const dir = makeDir(t, name);
  git(["init", "-q", dir]);
  git(["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

test("the acceptance script refuses any env that carries a nightqueue job identity, and only such an env", () => {
  assert.equal(jobIdentityRefusal({}), null);
  assert.equal(jobIdentityRefusal({ NIGHTQUEUE_JOB_ID: "  " }), null);
  for (const name of ["NIGHTQUEUE_JOB_ID", "NIGHTQUEUE_JOB_HOME", "NIGHTQUEUE_JOB_CLAUDE_DIR"]) {
    const refusal = jobIdentityRefusal({ [name]: "59" });
    assert.match(refusal, JOB_REFUSAL, name);
    assert.ok(refusal.includes(name), `the refusal does not name ${name}`);
  }
});

test("the acceptance script accepts only a checkout whose origin is the nstest-demo remote", () => {
  const origin = (url) => ({ gitRemoteImpl: () => url });
  assert.equal(demoOriginRefusal("/demo", origin("https://github.com/maykonVinicius/nstest-demo.git")), null);
  assert.equal(demoOriginRefusal("/demo", origin("git@github.com:maykonVinicius/nstest-demo.git")), null);
  assert.match(demoOriginRefusal("/demo", origin("git@github.com:nightqueue/nightqueue.git")), /its origin is nightqueue\/nightqueue, not maykonVinicius\/nstest-demo/);
  assert.match(demoOriginRefusal("/demo", origin("https://github.com/someone/nstest-demo.git")), /its origin is someone\/nstest-demo/);
  const unreadable = { gitRemoteImpl: () => { throw new Error("no origin"); } };
  assert.match(demoOriginRefusal("/demo", unreadable), /its origin is unreadable/);
});

test("the origin guard reads the real origin of a local checkout, and refuses the nightqueue repository", (t) => {
  assert.match(demoOriginRefusal(repoWithOrigin(t, "close-qa-nightqueue", "git@github.com:nightqueue/nightqueue.git")), /not maykonVinicius\/nstest-demo/);
  assert.equal(demoOriginRefusal(repoWithOrigin(t, "close-qa-demo", `https://github.com/${DEMO_REMOTE}.git`)), null);
  assert.match(demoOriginRefusal(makeDir(t, "close-qa-no-git")), /its origin is unreadable/);
});

test("run inside a job, the script refuses before anything else, even aimed at the nightqueue repository, and exits non-zero", (t) => {
  const repo = repoWithOrigin(t, "close-qa-spawn", "git@github.com:nightqueue/nightqueue.git");
  const env = { ...process.env, NIGHTQUEUE_JOB_ID: process.env.NIGHTQUEUE_JOB_ID || "4242" };
  const ran = spawnSync(process.execPath, [SCRIPT, "--repo", repo], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(ran.status, REFUSAL_EXIT, ran.stderr);
  assert.match(ran.stderr, JOB_REFUSAL);
  assert.equal(ran.stdout, "", "the script printed scenario output after refusing");
});
