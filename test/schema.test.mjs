import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "../src/config/errors.mjs";
import {
  NAME_RE,
  assertName,
  emptyConfig,
  emptySecrets,
  normalizeConfig,
  normalizeName,
  normalizeSecrets,
} from "../src/config/schema.mjs";

test("NAME_RE accepts the documented shape and rejects the rest", () => {
  for (const valid of ["a", "api", "web-2", "my.repo", "my_repo", "0abc", "a".repeat(64)]) {
    assert.equal(NAME_RE.test(valid), true, valid);
  }
  for (const invalid of ["", "-api", ".api", "_api", "API", "my repo", "feat+config", "a".repeat(65)]) {
    assert.equal(NAME_RE.test(invalid), false, invalid);
  }
});

test("assertName reports the kind and the offending value", () => {
  assert.equal(assertName("org", "acme"), "acme");
  assert.throws(() => assertName("project", "My Repo"), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /invalid project name `My Repo`/);
    return true;
  });
});

test("normalizeName rescues names derived from a directory basename", () => {
  assert.equal(normalizeName("MyRepo"), "myrepo");
  assert.equal(normalizeName("feat+config-org-based"), "feat-config-org-based");
  assert.equal(normalizeName("--weird--"), "weird");
  assert.equal(normalizeName("j\u00e1"), "j");
  assert.equal(normalizeName("+++"), "");
});

test("normalizeConfig fills defaults over a partial, hand-edited file", () => {
  const config = normalizeConfig({ defaultOrg: "acme", orgs: { acme: {} }, projects: { api: { path: "/tmp/api" } } });
  assert.equal(config.version, 1);
  assert.equal(config.defaultOrg, "acme");
  assert.equal(config.orgs.acme.displayName, "acme");
  assert.deepEqual({ ...config.orgs.acme.connections }, { github: null });
  assert.deepEqual(config.projects.api, { path: "/tmp/api", org: "acme" });
  assert.deepEqual(config.queue, { maxConcurrent: 2, resumeSession: false, leaseHeartbeatS: 5 });
  assert.deepEqual(emptyConfig().queue, { maxConcurrent: 2, resumeSession: false, leaseHeartbeatS: 5 });
});

test("the answer to the semantic recall is remembered only as a decline, and an old file simply has none", () => {
  assert.equal(emptyConfig().embedding, null);
  assert.equal(normalizeConfig({ embedding: "declined" }).embedding, "declined");
  for (const raw of ["accepted", "nonsense", true, 1, {}, null, undefined]) {
    assert.equal(normalizeConfig({ embedding: raw }).embedding, null, `\`${String(raw)}\` was kept as an answer`);
  }
});

test("queue.resumeSession only accepts a literal true, so `--resume` stays off by accident", () => {
  assert.equal(normalizeConfig({ queue: { resumeSession: true } }).queue.resumeSession, true);
  for (const raw of ["true", 1, "yes", {}, null]) {
    assert.equal(normalizeConfig({ queue: { resumeSession: raw } }).queue.resumeSession, false, `\`${String(raw)}\` turned it on`);
  }
});

test("queue.leaseHeartbeatS is clamped to the range that keeps a live runner ahead of the reclaim grace", () => {
  for (const valid of [1, 5, 20]) {
    assert.equal(normalizeConfig({ queue: { leaseHeartbeatS: valid } }).queue.leaseHeartbeatS, valid, String(valid));
  }
  for (const invalid of [0, -3, 21, 600, 2.5, "5", null, {}, undefined]) {
    assert.equal(
      normalizeConfig({ queue: { leaseHeartbeatS: invalid } }).queue.leaseHeartbeatS,
      5,
      `\`${String(invalid)}\` was accepted as a heartbeat`,
    );
  }
});

test("normalizeConfig recreates the default org and drops broken project entries", () => {
  const config = normalizeConfig({ orgs: null, projects: { api: { org: "default" }, web: { path: "/tmp/web" } } });
  assert.deepEqual(Object.keys(config.orgs), ["default"]);
  assert.equal(config.orgs.default.displayName, "Default");
  assert.deepEqual(Object.keys(config.projects), ["web"]);
  assert.deepEqual(normalizeConfig("nonsense"), emptyConfig());
});

test("normalizeSecrets keeps only well-formed connection entries", () => {
  const secrets = normalizeSecrets({ connections: { gh: { type: "github", token: "t" }, bad: { token: "t" } } });
  assert.deepEqual(Object.keys(secrets.connections), ["gh"]);
  assert.deepEqual(normalizeSecrets(undefined), emptySecrets());
});

test("a `__proto__` key in a hand-edited file never reaches the prototype of the built maps", () => {
  const raw = JSON.parse(
    '{"orgs":{"__proto__":{"displayName":"ghost","connections":{"github":"gh"}}},"projects":{"__proto__":{"path":"/tmp/ghost"}}}',
  );
  const config = normalizeConfig(raw);
  assert.equal(config.orgs.displayName, undefined);
  assert.equal(config.orgs.connections, undefined);
  assert.equal(config.orgs.ghost, undefined);
  assert.equal(config.projects.path, undefined);
  assert.equal(Object.getPrototypeOf(config.orgs), null);
  assert.equal(Object.getPrototypeOf(config.projects), null);
  assert.equal(Object.getPrototypeOf(config.orgs.default.connections), null);
  assert.equal({}.displayName, undefined);
  assert.equal(JSON.stringify(config.orgs.default), '{"displayName":"Default","connections":{"github":null}}');
});

test("a `__proto__` connection in secrets.json stays inert data instead of answering lookups", () => {
  const secrets = normalizeSecrets(JSON.parse('{"connections":{"__proto__":{"type":"github","token":"t"}}}'));
  assert.equal(secrets.connections.type, undefined);
  assert.equal(secrets.connections.token, undefined);
  assert.equal(secrets.connections.nope, undefined);
  assert.equal(Object.getPrototypeOf(secrets.connections), null);
  assert.deepEqual(Object.keys(secrets.connections), ["__proto__"]);
});

test("a file written by a newer nightshift is refused instead of silently downgraded", () => {
  assert.throws(() => normalizeConfig({ version: 2, orgs: {} }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /config\.json was written by a newer nightshift \(version 2\)/);
    assert.match(err.message, /supports version 1/);
    return true;
  });
  assert.throws(() => normalizeSecrets({ version: 5, connections: {} }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /secrets\.json was written by a newer nightshift \(version 5\)/);
    return true;
  });
  assert.equal(normalizeConfig({ version: 1, orgs: {} }).version, 1);
});

test("a project pointing at an unknown org is reported, not rewritten", () => {
  const warnings = [];
  const raw = { orgs: { acme: {} }, defaultOrg: "acme", projects: { api: { path: "/tmp/api", org: "ghost" } } };
  const config = normalizeConfig(raw, { warn: (line) => warnings.push(line) });
  assert.equal(config.projects.api.org, "ghost");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^nightshift: warning: project `api` points to unknown org `ghost`/);
  assert.match(warnings[0], /run `nightshift project move api <org>`/);
  assert.deepEqual(normalizeConfig(raw).projects.api, { path: "/tmp/api", org: "ghost" });
});
