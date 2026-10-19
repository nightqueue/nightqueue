import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runEasAsync } from "../../src/host/eas.mjs";
import { otaCommentLine } from "../../src/integrations/ota.mjs";
import { forgetOta, otaBudgetS, otaStep } from "../../src/integrations/post-close.mjs";
import { copyEnvFile, envFileNames } from "../../src/queue/close-deps.mjs";

const MERGE_SHA = "abc1234def5678";
const GROUP = "0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7";
const SENTINEL = "SENTINEL_VALUE_9f3a77";
const OWN_ENV = { NIGHTQUEUE_CLOSE_WORKER: "close:secret-lease", NIGHTQUEUE_HOME: "/home/nq", PATH: "/usr/bin" };
const UPDATE_JSON = JSON.stringify([{ id: "u1", group: GROUP, branch: "production" }]);
const PROJECT_INFO = "fullName  @acme/shop-app\nID        1234";
const OTA_ON = { expo: { ota: true } };

// A temporary directory removed after the test.
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A checkout with root `.env*` files: `.env` and `.env.local` untracked, `.env.example` tracked, plus a `sub/.env` and a `.envdir/` directory.
function checkoutWithEnv(t) {
  const checkout = tempDir(t, "nq-ota-checkout-");
  writeFileSync(join(checkout, ".env"), `EXPO_PUBLIC_API_KEY=${SENTINEL}\n`);
  writeFileSync(join(checkout, ".env.local"), "EXPO_PUBLIC_FLAG=on\n");
  writeFileSync(join(checkout, ".env.example"), "EXPO_PUBLIC_API_KEY=\n");
  writeFileSync(join(checkout, "README.md"), "app\n");
  mkdirSync(join(checkout, "sub"));
  writeFileSync(join(checkout, "sub", ".env"), "NESTED=1\n");
  mkdirSync(join(checkout, ".envdir"));
  return checkout;
}

// A fake execFile for eas: answers each subcommand with what `answers` maps it to, recording every call with what its cwd held.
function fakeEasExec(answers = {}) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    const copies = existsSync(options.cwd ?? "") ? envCopiesIn(options.cwd) : null;
    calls.push({ file, args, cwd: options.cwd, env: options.env, timeout: options.timeout, copies });
    const answer = answers[args[0]] ?? { stdout: "" };
    if (typeof answer === "function") return answer(options, callback);
    const err = answer.code === undefined ? null : Object.assign(new Error("Command failed"), { code: answer.code });
    setImmediate(() => callback(err, answer.stdout ?? "", answer.stderr ?? ""));
  };
  return { impl, calls };
}

// What the `.env*` copies of a directory are: per name, whether it is a regular file, its mode and its bytes.
function envCopiesIn(dir) {
  return Object.fromEntries(
    [".env", ".env.local", ".env.example"].filter((name) => existsSync(join(dir, name))).map((name) => {
      const stat = lstatSync(join(dir, name));
      return [name, { file: stat.isFile(), link: stat.isSymbolicLink(), mode: stat.mode & 0o777, text: readFileSync(join(dir, name), "utf8") }];
    }),
  );
}

// Fake eas deps over the real runner, so the env stripping and the argv are the real ones.
function easDeps(exec, { whoami = { installed: true, authenticated: true, login: "alice", host: null } } = {}) {
  const calls = { whoami: 0 };
  return {
    calls,
    eas: {
      whoami: async () => {
        calls.whoami += 1;
        return whoami;
      },
      update: (args, options = {}) => runEasAsync(args, { ...options, env: OWN_ENV, execFileImpl: exec.impl }),
      projectInfo: (args, options = {}) => runEasAsync(args, { ...options, env: OWN_ENV, execFileImpl: exec.impl }),
    },
  };
}

// A fake git recording its calls: worktree add creates nothing (the temp dir already exists), ls-files answers the tracked names.
function fakeGit({ tracked = [".env.example"], lsFiles = true, addFails = 0, fetchOk = true } = {}) {
  const calls = [];
  let adds = 0;
  const impl = async (args, options = {}) => {
    calls.push({ args, cwd: options.cwd });
    if (args[0] === "worktree" && args[1] === "add") {
      adds += 1;
      return adds <= addFails ? { ok: false, stdout: "", stderr: "fatal: invalid reference" } : { ok: true, stdout: "", stderr: "" };
    }
    if (args.includes("ls-files")) return lsFiles ? { ok: true, stdout: tracked.map((name) => `${name}\0`).join(""), stderr: "" } : { ok: false, stdout: "", stderr: "fatal" };
    if (args[0] === "fetch") return { ok: fetchOk, stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  return { impl, calls };
}

// The real filesystem deps of a close, with the throwaway dirs it made recorded and copyEnvFile replaceable.
function realFs(t, { copy = copyEnvFile } = {}) {
  const made = [];
  return {
    made,
    fs: {
      exists: (path) => existsSync(path),
      makeTempDir: (prefix) => {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        made.push(dir);
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        return dir;
      },
      removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
      linkNodeModules: () => false,
      envFileNames,
      copyEnvFile: copy,
    },
  };
}

// The context the OTA step reads, with its progress lines recorded.
function otaCtx({ checkout, integrations = OTA_ON, data = { mergeSha: MERGE_SHA, baseBranch: "main" }, resolution = "merged", signal = new AbortController().signal } = {}) {
  const progress = [];
  return {
    progress,
    ctx: {
      jobId: 7,
      jobRef: "J-7",
      title: "fix the login\ncrash",
      checkout,
      integrations,
      data,
      resolution,
      signal,
      nowMs: () => Date.now(),
      remainingMs: () => 660000,
      progress: (line) => progress.push(line),
    },
  };
}

// Runs the OTA step over a checkout with the given fakes, answering the result and every fake.
async function runOta(t, { checkout = checkoutWithEnv(t), git = fakeGit(), exec = fakeEasExec({ update: { stdout: UPDATE_JSON }, "project:info": { stdout: PROJECT_INFO } }), whoami, fs, ...rest } = {}) {
  const files = fs ?? realFs(t);
  const eas = easDeps(exec, whoami ? { whoami } : {});
  const { ctx, progress } = otaCtx({ checkout, ...rest });
  const result = await otaStep({ ctx, deps: { git: git.impl, fs: files.fs, eas: eas.eas } });
  return { result, git, exec, eas, files, progress, ctx };
}

// The eas update calls a fake recorded.
function updateCalls(exec) {
  return exec.calls.filter((call) => call.args[0] === "update");
}

test("the OTA step skips with a note and calls no eas update when OTA is off, the close had no change, or eas is missing or logged out", async (t) => {
  const cases = [
    { name: "off", options: { integrations: { expo: { branch: "production" } } }, note: "expo.ota is off", notice: false },
    { name: "unset", options: { integrations: { linear: { enabled: true } } }, note: "expo.ota is off", notice: false },
    { name: "no-change", options: { resolution: "no-change" }, note: "the job closed without a code change", notice: false },
    { name: "missing", options: { whoami: { installed: false, authenticated: false, login: null, host: null } }, note: "eas is not installed", notice: true },
    { name: "logged-out", options: { whoami: { installed: true, authenticated: false, login: null, host: null } }, note: "eas is not logged in; run `eas login`", notice: true },
  ];
  for (const { name, options, note, notice } of cases) {
    const { result, exec, git, files } = await runOta(t, options);
    assert.equal(result.status, "skipped", name);
    assert.equal(result.note, note, name);
    assert.equal(result.notice, notice, name);
    assert.deepEqual(result.data.ota, { status: "skipped", branch: "production", groupId: null, url: null, note }, name);
    assert.equal(updateCalls(exec).length, 0, name);
    assert.equal(git.calls.length, 0, name);
    assert.equal(files.made.length, 0, name);
  }
});

test("a done publish stores the group and the expo.dev url, after copying exactly the untracked root env files as private regular files", async (t) => {
  const { result, exec, git, files, progress } = await runOta(t, { integrations: { expo: { ota: true, branch: "staging" } } });
  const url = `https://expo.dev/accounts/acme/projects/shop-app/updates/${GROUP}`;
  assert.equal(result.status, "done");
  assert.equal(result.note, `published ${GROUP.slice(0, 8)} to staging`);
  assert.deepEqual(result.data.ota, { status: "done", branch: "staging", groupId: GROUP, url, note: null });

  const [update] = updateCalls(exec);
  const [dir] = files.made;
  assert.deepEqual(update.args, ["update", "--branch", "staging", "--message", "J-7: fix the login crash", "--non-interactive", "--json"]);
  assert.equal(update.cwd, dir);
  assert.ok(dir.includes("nightqueue-ota-7-"));
  assert.deepEqual(Object.keys(update.env).filter((key) => key.startsWith("NIGHTQUEUE_")), []);
  assert.equal(update.env.PATH, "/usr/bin");
  assert.deepEqual(update.copies, {
    ".env": { file: true, link: false, mode: 0o600, text: `EXPO_PUBLIC_API_KEY=${SENTINEL}\n` },
    ".env.local": { file: true, link: false, mode: 0o600, text: "EXPO_PUBLIC_FLAG=on\n" },
  });
  assert.deepEqual(exec.calls.map((call) => call.args[0]), ["update", "project:info"]);

  const lsFiles = git.calls.find((call) => call.args.includes("ls-files"));
  assert.deepEqual(lsFiles.args, ["--literal-pathspecs", "ls-files", "-z", "--", ".env", ".env.example", ".env.local"]);
  assert.deepEqual(git.calls[0].args, ["worktree", "add", "--detach", dir, MERGE_SHA]);
  assert.deepEqual(git.calls.slice(-2).map((call) => call.args.slice(0, 2)), [["worktree", "remove"], ["worktree", "prune"]]);
  assert.equal(existsSync(dir), false, "the throwaway worktree and its env copies are gone");
  assert.deepEqual(progress, ["copied 2 env files", "publishing an OTA update to staging"]);
  assert.ok(!JSON.stringify([result, progress]).includes(SENTINEL));
});

test("a done publish whose project:info fails stores url null, and a checkout without env files still publishes", async (t) => {
  const bare = tempDir(t, "nq-ota-bare-");
  const exec = fakeEasExec({ update: { stdout: UPDATE_JSON }, "project:info": { code: 1, stderr: "not a project" } });
  const { result, git, files } = await runOta(t, { checkout: bare, exec });
  assert.equal(result.status, "done");
  assert.deepEqual(result.data.ota, { status: "done", branch: "production", groupId: GROUP, url: null, note: null });
  assert.equal(git.calls.some((call) => call.args.includes("ls-files")), false);
  assert.equal(existsSync(files.made[0]), false);
});

test("a failed eas update is a warning with the reason and at most 20 output lines, the worktree removed and the close not failed", async (t) => {
  const output = Array.from({ length: 30 }, (_, index) => `\u001b[31mline ${index + 1}\u001b[0m`).join("\n");
  const exec = fakeEasExec({ update: { code: 1, stdout: "", stderr: output } });
  const { result, files } = await runOta(t, { exec });
  const lines = result.note.split("\n");
  assert.equal(result.status, "warning");
  assert.equal(result.notice, true);
  assert.equal(lines[0], "eas update exited 1");
  assert.equal(lines.length, 21);
  assert.equal(lines[1], "line 11");
  assert.equal(lines[20], "line 30");
  assert.deepEqual(result.data.ota, { status: "warning", branch: "production", groupId: null, url: null, note: result.note });
  assert.equal(existsSync(files.made[0]), false);
});

test("an eas update answering no group is a warning, and an abort during the update removes the worktree", async (t) => {
  const empty = await runOta(t, { exec: fakeEasExec({ update: { stdout: "[]" } }) });
  assert.equal(empty.result.status, "warning");
  assert.equal(empty.result.note.split("\n")[0], "eas answered no update group");

  const controller = new AbortController();
  const hanging = fakeEasExec({
    update: (options, callback) => {
      options.signal.addEventListener("abort", () => callback(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }), "", ""), { once: true });
      setImmediate(() => controller.abort());
    },
  });
  const aborted = await runOta(t, { exec: hanging, signal: controller.signal });
  assert.equal(aborted.result.status, "warning");
  assert.equal(aborted.result.note.split("\n")[0], "eas update was interrupted");
  assert.equal(existsSync(aborted.files.made[0]), false);
  assert.ok(aborted.git.calls.some((call) => call.args[1] === "remove"));
});

test("when git ls-files fails or a copy throws, nothing is published, the worktree is removed and no note holds the file content", async (t) => {
  const listing = await runOta(t, { git: fakeGit({ lsFiles: false }) });
  assert.equal(listing.result.status, "warning");
  assert.equal(listing.result.note, "could not tell which .env files are untracked (git ls-files failed)");
  assert.equal(updateCalls(listing.exec).length, 0);
  assert.equal(existsSync(listing.files.made[0]), false);

  const throwing = () => {
    throw Object.assign(new Error(`EACCES: cannot copy, content ${SENTINEL}`), { code: "EACCES" });
  };
  const copying = await runOta(t, { fs: realFs(t, { copy: throwing }) });
  assert.equal(copying.result.status, "warning");
  assert.equal(copying.result.note, "could not copy .env into the OTA worktree (EACCES)");
  assert.equal(updateCalls(copying.exec).length, 0);
  assert.equal(existsSync(copying.files.made[0]), false);
  for (const run of [listing, copying]) {
    assert.ok(!JSON.stringify([run.result, run.progress, run.git.calls]).includes(SENTINEL));
  }
});

test("a merge commit not local yet is fetched once from the base branch, and a recorded done publish is not published again until forgotten", async (t) => {
  const git = fakeGit({ addFails: 1 });
  const first = await runOta(t, { git });
  assert.equal(first.result.status, "done");
  assert.deepEqual(git.calls.filter((call) => call.args[0] === "fetch").map((call) => call.args), [["fetch", "origin", "main"]]);

  const data = { mergeSha: MERGE_SHA, baseBranch: "main", ota: first.result.data.ota };
  const again = await runOta(t, { data });
  assert.equal(again.result.status, "done");
  assert.equal(again.result.note, `already published ${GROUP.slice(0, 8)} to production`);
  assert.equal(again.result.data, undefined);
  assert.equal(updateCalls(again.exec).length, 0);

  forgetOta(data);
  assert.equal(data.ota, undefined);
  const republished = await runOta(t, { data });
  assert.equal(updateCalls(republished.exec).length, 1);
});

test("the OTA step warns without a merge commit, and whoami not answering is a warning", async (t) => {
  const noMerge = await runOta(t, { data: {} });
  assert.equal(noMerge.result.status, "warning");
  assert.equal(noMerge.result.note, "no merge commit recorded");
  const silent = await runOta(t, { whoami: { installed: true, authenticated: null, login: null, host: null } });
  assert.equal(silent.result.status, "warning");
  assert.equal(silent.result.note, "eas whoami did not answer");
  assert.equal(silent.files.made.length, 0);
});

test("a throwaway worktree that cannot be created posts a fixed reason, never a local path", async (t) => {
  const failingTemp = realFs(t);
  failingTemp.fs.makeTempDir = () => {
    throw new Error("EACCES: permission denied, mkdtemp '/Users/secret-user/tmp/nightqueue-ota-x'");
  };
  const noTemp = await runOta(t, { fs: failingTemp });
  const addFails = await runOta(t, { git: fakeGit({ addFails: 2 }) });
  for (const { result, exec } of [noTemp, addFails]) {
    assert.equal(result.status, "warning");
    assert.equal(result.note.split("\n")[0], "could not create the OTA worktree");
    assert.equal(otaCommentLine(result.data.ota), "OTA failed: could not create the OTA worktree");
    assert.equal(updateCalls(exec).length, 0);
  }
  assert.match(noTemp.result.note.split("\n")[1], /mkdtemp/);
});

test("a stored branch the provider's pattern refuses is a warning before any git or eas call", async (t) => {
  const { result, git, exec, files, eas } = await runOta(t, { integrations: { expo: { ota: true, branch: "a b; rm -rf" } } });
  assert.equal(result.status, "warning");
  assert.equal(result.note, "expo.branch is not a valid branch name");
  assert.deepEqual(result.data.ota, { status: "warning", branch: null, groupId: null, url: null, note: result.note });
  assert.equal(git.calls.length, 0);
  assert.equal(exec.calls.length, 0);
  assert.equal(eas.calls.whoami, 0);
  assert.equal(files.made.length, 0);
});

test("the whoami of the OTA step gets the close's signal", async (t) => {
  const controller = new AbortController();
  let seen = null;
  const { ctx } = otaCtx({ checkout: checkoutWithEnv(t), signal: controller.signal });
  const whoami = async (options) => {
    seen = options;
    return { installed: true, authenticated: false, login: null, host: null };
  };
  await otaStep({ ctx, deps: { git: fakeGit().impl, fs: realFs(t).fs, eas: { whoami } } });
  assert.equal(seen.signal, controller.signal);
});

test("the OTA budget is 600 s only when the project turned OTA on", () => {
  assert.equal(otaBudgetS({ integrations: OTA_ON }), 600);
  assert.equal(otaBudgetS({ integrations: { expo: { ota: false } } }), 0);
  assert.equal(otaBudgetS({ integrations: { linear: { enabled: true } } }), 0);
  assert.equal(otaBudgetS({ integrations: null }), 0);
});

test("envFileNames lists only root .env regular files, and copyEnvFile makes a 0600 copy, never a link", (t) => {
  const checkout = checkoutWithEnv(t);
  assert.deepEqual(envFileNames(checkout), [".env", ".env.example", ".env.local"]);
  const dir = tempDir(t, "nq-ota-copy-");
  copyEnvFile(checkout, dir, ".env");
  const stat = lstatSync(join(dir, ".env"));
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), `EXPO_PUBLIC_API_KEY=${SENTINEL}\n`);
});
