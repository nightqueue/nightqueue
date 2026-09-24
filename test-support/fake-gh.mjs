#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);

// Records the call in the argv log the test reads back.
function logCall() {
  const path = process.env.NIGHTQUEUE_FAKE_GH_LOG;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(args)}\n`);
}

// Ends the process the way the real CLI ends when it cannot answer.
function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// Token this fake is allowed to hand out; without it the fake refuses to invent one.
function token() {
  const value = process.env.NIGHTQUEUE_FAKE_GH_TOKEN;
  if (!value) fail("fake gh: NIGHTQUEUE_FAKE_GH_TOKEN is not set; refusing to invent a token", 2);
  return value;
}

// Tells whether the test asked this fake to look logged in.
function authenticated() {
  return process.env.NIGHTQUEUE_FAKE_GH_STATE === "authenticated";
}

// Answers `gh auth status`, writing the identity line on the stream the real CLI uses for a pipe.
function authStatus() {
  if (!authenticated()) fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  const login = process.env.NIGHTQUEUE_FAKE_GH_LOGIN || "octocat";
  process.stdout.write(`github.com\n  Logged in to github.com account ${login} (keyring)\n`);
}

// Answers `gh pr view --json` with the state the test asked for; without one the fake refuses to invent it.
function prView() {
  const state = process.env.NIGHTQUEUE_FAKE_GH_PR_STATE;
  if (!state) fail("fake gh: NIGHTQUEUE_FAKE_GH_PR_STATE is not set; refusing to invent a pull request state", 2);
  const sha = process.env.NIGHTQUEUE_FAKE_GH_PR_SHA || null;
  const merged = state === "MERGED";
  const payload = {
    state,
    mergedAt: merged ? "2026-09-11T15:54:01Z" : null,
    mergeCommit: merged && sha ? { oid: sha } : null,
    mergeable: process.env.NIGHTQUEUE_FAKE_GH_PR_MERGEABLE || "MERGEABLE",
    isDraft: process.env.NIGHTQUEUE_FAKE_GH_PR_DRAFT === "1",
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// Answers `gh pr create` with the URL the test asked for; without one the fake refuses to invent it.
function prCreate() {
  const url = process.env.NIGHTQUEUE_FAKE_GH_PR_URL;
  if (!url) fail("fake gh: NIGHTQUEUE_FAKE_GH_PR_URL is not set; refusing to invent a pull request URL", 2);
  process.stdout.write(`${url}\n`);
}

// Answers `gh pr list --json` with the pull requests the test asked for; without them the fake refuses to invent a list.
function prList() {
  const raw = process.env.NIGHTQUEUE_FAKE_GH_PR_LIST;
  if (!raw) fail("fake gh: NIGHTQUEUE_FAKE_GH_PR_LIST is not set; refusing to invent a pull request list", 2);
  process.stdout.write(`${raw}\n`);
}

// Holds the process for as long as the test asked, the way a slow network makes the real CLI hang.
function sleepIfAsked() {
  const ms = Number(process.env.NIGHTQUEUE_FAKE_GH_SLEEP_MS);
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Applies the call, emulating only the subcommands the import uses.
function main() {
  logCall();
  sleepIfAsked();
  const [command, sub] = args;
  if (command === "auth" && sub === "status") return authStatus();
  if (command === "auth" && sub === "token") return process.stdout.write(`${token()}\n`);
  if (command === "pr" && sub === "view") return prView();
  if (command === "pr" && sub === "create") return prCreate();
  if (command === "pr" && sub === "list") return prList();
  return fail(`fake gh: unknown command \`${args.join(" ")}\``);
}

main();
