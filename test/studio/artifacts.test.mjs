import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { addJob, bindRunSlug, claimJobById } from "../../src/memory/jobs.mjs";
import { artifactSummary, listArtifacts, readArtifactFile } from "../../src/studio/artifacts.mjs";
import { ensureProject, makeDir, makeHome } from "../../test-support/memory.mjs";
import { send, startStudio, studioCookie } from "../../test-support/studio.mjs";

const MIB = 1024 * 1024;
const OUTSIDE_TEXT = "outside the run dir\n";
const PLAN_TEXT = "intro line\n## The plan\n\nbody\n";
const PLAN_BYTES = Buffer.byteLength(PLAN_TEXT);

// A run directory with one artifact of each kind the listing must keep or skip.
function seedRunDir(dir, outside) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "03-plan.md"), PLAN_TEXT);
  writeFileSync(join(dir, "01-triage.md"), "no heading at all\n");
  writeFileSync(join(dir, "notes.txt"), "# not markdown\n");
  writeFileSync(join(dir, "state.json"), "{}\n");
  writeFileSync(join(dir, ".hidden.md"), "# hidden\n");
  mkdirSync(join(dir, "sub.md"));
  writeFileSync(outside, OUTSIDE_TEXT);
  symlinkSync(outside, join(dir, "evil.md"));
}

test("the listing keeps regular markdown files with their size, title and mtime, and skips the rest", (t) => {
  const root = makeDir(t, "artifacts-list");
  const dir = join(root, "run");
  seedRunDir(dir, join(root, "outside.md"));
  const entries = listArtifacts(dir);
  assert.deepEqual(
    entries.map(({ name, bytes, title }) => [name, bytes, title]),
    [
      ["01-triage.md", 18, null],
      ["03-plan.md", PLAN_BYTES, "The plan"],
    ],
  );
  assert.ok(!Number.isNaN(Date.parse(entries[0].mtime)));
  assert.deepEqual(listArtifacts(join(root, "absent")), []);
  assert.deepEqual(listArtifacts(null), []);
});

test("one artifact is read only when it is a listed regular file, and above the cap it is cut on a code point", (t) => {
  const root = makeDir(t, "artifacts-read");
  const dir = join(root, "run");
  seedRunDir(dir, join(root, "outside.md"));
  assert.deepEqual(artifactSummary(dir, "03-plan.md"), { bytes: PLAN_BYTES, title: "The plan" });
  assert.deepEqual(readArtifactFile(dir, "03-plan.md"), { text: PLAN_TEXT, truncated: false });
  for (const name of ["evil.md", "sub.md", ".hidden.md", "notes.txt", "state.json", "../outside.md", join(root, "outside.md")]) {
    assert.equal(readArtifactFile(dir, name), null, `${name} was read`);
    assert.equal(artifactSummary(dir, name), null, `${name} was summarised`);
  }
  writeFileSync(join(dir, "big.md"), `${"a".repeat(9)}é`);
  const cut = readArtifactFile(dir, "big.md", 10);
  assert.deepEqual(cut, { text: "a".repeat(9), truncated: true });
});

// A home with a job whose slug points at a seeded run directory, and the path of its log.
function seededJob(t, name) {
  const env = makeHome(t, name);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  bindRunSlug(id, { worker: "host:1", candidates: ["fix-the-worker"] }, env);
  const dir = runDir(projectId, "fix-the-worker", env);
  seedRunDir(dir, join(makeDir(t, `${name}-outside`), "outside.md"));
  return { env, id, dir };
}

test("the artifacts route lists the run directory, serves one file as markdown and cuts a large one at 1 MiB", async (t) => {
  const { env, id, dir } = seededJob(t, "studio-artifacts-route");
  writeFileSync(join(dir, "big.md"), `${"a".repeat(MIB - 1)}é`);
  const { port } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port) };
  const listing = await send(port, { path: `/api/jobs/J-${id}/artifacts`, headers });
  assert.equal(listing.status, 200);
  assert.deepEqual(
    JSON.parse(listing.body).artifacts.map((entry) => entry.name),
    ["01-triage.md", "03-plan.md", "big.md"],
  );
  const plan = await send(port, { path: `/api/jobs/J-${id}/artifacts/03-plan.md`, headers });
  assert.deepEqual([plan.status, plan.headers["content-type"], plan.headers["x-content-type-options"], plan.headers["cache-control"]], [200, "text/markdown; charset=utf-8", "nosniff", "no-store"]);
  assert.equal(plan.body, PLAN_TEXT);
  assert.equal(plan.headers["x-nightqueue-truncated"], undefined);
  const big = await send(port, { path: `/api/jobs/J-${id}/artifacts/big.md`, headers });
  assert.deepEqual([big.status, big.headers["x-nightqueue-truncated"], Buffer.byteLength(big.body)], [200, "1", MIB - 1]);
  assert.equal(big.body.includes("�"), false);
});

test("the artifact route refuses every name outside the listing, a malformed escape and an unknown job", async (t) => {
  const { env, id } = seededJob(t, "studio-artifacts-traversal");
  const { port } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port) };
  const status = async (path) => (await send(port, { path, headers })).status;
  for (const name of ["..%2F..%2Fetc%2Fpasswd", "%2e%2e", "%2e%2e%2fstate.json", "state.json", "evil.md", "sub.md", ".hidden.md", "notes.txt", "%2Fetc%2Fhosts"]) {
    assert.equal(await status(`/api/jobs/J-${id}/artifacts/${name}`), 404, `${name} was not refused`);
  }
  assert.equal(await status(`/api/jobs/J-${id}/artifacts/%E0`), 400);
  assert.equal(await status("/api/jobs/J-999/artifacts"), 404);
  assert.equal(await status("/api/jobs/J-999/artifacts/03-plan.md"), 404);
  assert.equal(await status("/api/jobs/nope/artifacts"), 400);
});

test("a job without a run directory lists no artifacts", async (t) => {
  const env = makeHome(t, "studio-artifacts-none");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const { port } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port) };
  const listing = await send(port, { path: `/api/jobs/J-${id}/artifacts`, headers });
  assert.deepEqual([listing.status, JSON.parse(listing.body)], [200, { artifacts: [] }]);
  assert.equal((await send(port, { path: `/api/jobs/J-${id}/artifacts/03-plan.md`, headers })).status, 404);
});

test("the log route serves from a byte offset when asked, refuses a bad offset, and answers as before without one", async (t) => {
  const env = makeHome(t, "studio-log-from");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const text = "first line\nsecond ✓ line\n";
  mkdirSync(dirname(jobLogPath(id, env)), { recursive: true });
  writeFileSync(jobLogPath(id, env), text);
  const { port } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port) };
  const log = (query) => send(port, { path: `/api/jobs/J-${id}/log${query}`, headers });
  const whole = await log("");
  assert.deepEqual([whole.status, whole.body, whole.headers["content-type"]], [200, text, "text/plain; charset=utf-8"]);
  assert.deepEqual([(await log("?from=11")).body, (await log("?from=0")).body], ["second ✓ line\n", text]);
  const past = await log(`?from=${Buffer.byteLength(text)}`);
  assert.deepEqual([past.status, past.body], [200, ""]);
  for (const bad of ["-1", "abc", "1.5", "", "1e3"]) assert.equal((await log(`?from=${bad}`)).status, 400, `from=${bad} was accepted`);
  assert.equal((await send(port, { path: "/api/jobs/J-999/log?from=0", headers })).status, 404);
});
