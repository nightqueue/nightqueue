import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { openDb } from "../src/memory/db.mjs";
import * as registry from "../src/memory/registry.mjs";
import { makeDir, makeHome } from "../test-support/memory.mjs";

// A directory that looks like a git repository, without calling git.
function makeRepo(t, name) {
  const dir = makeDir(t, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return realpathSync(dir);
}

// Terminal double that answers the first question with the given line, or no terminal at all when the answer is null.
function terminal(answer) {
  if (answer === null) return { stdin: { isTTY: false }, stdout: new PassThrough(), written: [] };
  const stdin = Readable.from([answer]);
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const written = [];
  stdout.on("data", (chunk) => written.push(String(chunk)));
  return { stdin, stdout, written };
}

// Runs one CLI command against a home and answers its exit code, output lines, error lines and what the terminal was asked.
async function cli(env, argv, { answer = null } = {}) {
  const out = [];
  const err = [];
  const tty = terminal(answer);
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line), stdin: tty.stdin, stdout: tty.stdout };
  const code = await run(argv, ctx);
  return { code, out, err: err.join("\n"), asked: tty.written.join("") };
}

// Registers a repository under a name, with the extra arguments given, and asserts it worked.
async function addProject(t, env, name, extra = [], options = {}) {
  const repo = makeRepo(t, `key-${name}`);
  const result = await cli(env, ["project", "add", repo, "--name", name, ...extra], options);
  assert.equal(result.code, 0, result.err);
  return { repo, ...result };
}

// The key the registry holds for a project.
function projectKey(env, name) {
  return registry.projectByName(openDb(env), name)?.key;
}

test("project add suggests a key without a terminal, takes --key, and adds a letter on a collision", async (t) => {
  const env = makeHome(t, "project-key-add");

  const suggested = await addProject(t, env, "nightqueue");
  assert.deepEqual(suggested.out, [`registered project \`nightqueue\` (${suggested.repo}) with key NQ`]);

  const collided = await addProject(t, env, "night-queue");
  assert.equal(projectKey(env, "night-queue"), "NQA");
  assert.match(collided.out[0], /with key NQA$/);

  await addProject(t, env, "api", ["--key", "api1"]);
  assert.equal(projectKey(env, "api"), "API1");

  const invalid = await cli(env, ["project", "add", makeRepo(t, "key-invalid"), "--name", "web", "--key", "w"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.err, /key `w` is invalid: a key is 2 to 5 uppercase letters or digits and starts with a letter/);
  assert.equal(projectKey(env, "web"), undefined);

  const taken = await cli(env, ["project", "add", makeRepo(t, "key-taken"), "--name", "web", "--key", "NQ"]);
  assert.equal(taken.code, 1);
  assert.match(taken.err, /key `NQ` is taken: it is the key of project `nightqueue`/);
  assert.equal(projectKey(env, "web"), undefined);
});

test("project add on a terminal asks the key: Enter takes the suggestion, text replaces it, an invalid answer is refused", async (t) => {
  const env = makeHome(t, "project-key-prompt");

  const accepted = await addProject(t, env, "nightqueue", [], { answer: "\n" });
  assert.equal(accepted.asked, "Key for project `nightqueue` [NQ]: ");
  assert.equal(projectKey(env, "nightqueue"), "NQ");

  await addProject(t, env, "api", [], { answer: "srv\n" });
  assert.equal(projectKey(env, "api"), "SRV");

  const invalid = await cli(env, ["project", "add", makeRepo(t, "key-prompt-bad"), "--name", "web"], { answer: "1abc\n" });
  assert.equal(invalid.code, 1);
  assert.match(invalid.err, /key `1abc` is invalid/);
  assert.equal(projectKey(env, "web"), undefined);

  const flagged = await addProject(t, env, "worker", ["--key", "WK"], { answer: "\n" });
  assert.equal(flagged.asked, "", "--key still asked the terminal");
  assert.equal(projectKey(env, "worker"), "WK");
});

test("project key changes the key in one row, keeps the old one as an alias that still resolves, and lists both", async (t) => {
  const env = makeHome(t, "project-key-rename");
  const { repo } = await addProject(t, env, "nightqueue");

  const changed = await cli(env, ["project", "key", "nightqueue", "nx"]);
  assert.equal(changed.code, 0, changed.err);
  assert.deepEqual(changed.out, ["changed the key of project `nightqueue` from NQ to NX; NQ refs still resolve"]);
  const db = openDb(env);
  assert.equal(registry.ownerByKey(db, "NQ")?.projectId, registry.ownerByKey(db, "NX")?.projectId);
  assert.equal(registry.keyHolder(db, "NQ")?.current, false);

  const text = await cli(env, ["project", "list"]);
  assert.deepEqual(text.out, [`nightqueue  NX  ${repo}  default  ok`]);

  const json = await cli(env, ["project", "list", "--json"]);
  const [listed] = JSON.parse(json.out[0]).projects;
  assert.equal(listed.key, "NX");
  assert.deepEqual(listed.aliases, ["NQ"]);
});

test("project key refuses a taken key, another owner's old key, the same key, an invalid key and an unknown project", async (t) => {
  const env = makeHome(t, "project-key-refusals");
  await addProject(t, env, "nightqueue");
  await addProject(t, env, "api", ["--key", "AP"]);
  assert.equal((await cli(env, ["project", "key", "api", "SRV"])).code, 0);

  const cases = [
    [["project", "key", "nightqueue", "SRV"], /key `SRV` is taken: it is the key of project `api`/],
    [["project", "key", "nightqueue", "AP"], /key `AP` is taken: it is an old key of project `api`/],
    [["project", "key", "nightqueue", "DA"], /key `DA` is taken: it is the key of org `default`/],
    [["project", "key", "nightqueue", "NQ"], /project `nightqueue` already has key `NQ`/],
    [["project", "key", "nightqueue", "N-Q"], /key `N-Q` is invalid/],
    [["project", "key", "ghost", "GH"], /unknown project `ghost`/],
    [["project", "key", "nightqueue"], /usage: nightqueue project key <name> <KEY>/],
  ];
  for (const [argv, message] of cases) {
    const refused = await cli(env, argv);
    assert.equal(refused.code, 1, argv.join(" "));
    assert.match(refused.err, message, argv.join(" "));
  }
  assert.equal(projectKey(env, "nightqueue"), "NQ");

  const reclaimed = await cli(env, ["project", "key", "api", "AP"]);
  assert.equal(reclaimed.code, 0, reclaimed.err);
  assert.equal(projectKey(env, "api"), "AP");
});

test("org add suggests or asks a key, org key renames it, and org list shows the key and its old ones", async (t) => {
  const env = makeHome(t, "org-key");

  const suggested = await cli(env, ["org", "add", "dlweb"]);
  assert.equal(suggested.code, 0, suggested.err);
  assert.deepEqual(suggested.out, ["created org `dlweb` with key DW"]);

  const flagged = await cli(env, ["org", "add", "acme", "--key", "acm"]);
  assert.deepEqual(flagged.out, ["created org `acme` with key ACM"]);

  const asked = await cli(env, ["org", "add", "globex"], { answer: "gx\n" });
  assert.equal(asked.asked, "Key for org `globex` [GB]: ");
  assert.deepEqual(asked.out, ["created org `globex` with key GX"]);

  const taken = await cli(env, ["org", "add", "initech", "--key", "DW"]);
  assert.equal(taken.code, 1);
  assert.match(taken.err, /key `DW` is taken: it is the key of org `dlweb`/);

  const changed = await cli(env, ["org", "key", "dlweb", "DLW"]);
  assert.deepEqual(changed.out, ["changed the key of org `dlweb` from DW to DLW; DW refs still resolve"]);
  assert.equal(registry.ownerByKey(openDb(env), "DW")?.orgId, registry.orgByName(openDb(env), "dlweb").id);

  const text = await cli(env, ["org", "list"]);
  assert.ok(text.out.includes("  dlweb  DLW  github=-  projects=0"), text.out.join("\n"));

  const json = JSON.parse((await cli(env, ["org", "list", "--json"])).out[0]);
  const dlweb = json.orgs.find((org) => org.name === "dlweb");
  assert.equal(dlweb.key, "DLW");
  assert.deepEqual(dlweb.aliases, ["DW"]);

  const same = await cli(env, ["org", "key", "dlweb", "DLW"]);
  assert.equal(same.code, 1);
  assert.match(same.err, /org `dlweb` already has key `DLW`/);
});
