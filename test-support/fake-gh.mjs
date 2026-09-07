#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);

// Records the call in the argv log the test reads back.
function logCall() {
  const path = process.env.NIGHTSHIFT_FAKE_GH_LOG;
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
  const value = process.env.NIGHTSHIFT_FAKE_GH_TOKEN;
  if (!value) fail("fake gh: NIGHTSHIFT_FAKE_GH_TOKEN is not set; refusing to invent a token", 2);
  return value;
}

// Tells whether the test asked this fake to look logged in.
function authenticated() {
  return process.env.NIGHTSHIFT_FAKE_GH_STATE === "authenticated";
}

// Answers `gh auth status`, writing the identity line on the stream the real CLI uses for a pipe.
function authStatus() {
  if (!authenticated()) fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  const login = process.env.NIGHTSHIFT_FAKE_GH_LOGIN || "octocat";
  process.stdout.write(`github.com\n  Logged in to github.com account ${login} (keyring)\n`);
}

// Applies the call, emulating only the subcommands the import uses.
function main() {
  logCall();
  const [command, sub] = args;
  if (command === "auth" && sub === "status") return authStatus();
  if (command === "auth" && sub === "token") return process.stdout.write(`${token()}\n`);
  return fail(`fake gh: unknown command \`${args.join(" ")}\``);
}

main();
