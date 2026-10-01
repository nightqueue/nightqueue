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
  const config = normalizeConfig({ defaultOrg: "01J0000000000000000000ACME", orgConnections: { "01J0000000000000000000ACME": {} } });
  assert.equal(config.version, 1);
  assert.equal(config.defaultOrg, "01J0000000000000000000ACME");
  assert.deepEqual({ ...config.orgConnections["01J0000000000000000000ACME"] }, { github: null, sentry: null });
  assert.equal(emptyConfig().defaultOrg, null);
  assert.deepEqual({ ...emptyConfig().orgConnections }, {});
  assert.deepEqual(config.queue, {
    maxConcurrent: null,
    resumeSession: false,
    leaseHeartbeatS: 5,
    keepAwake: "auto",
    bashTimeoutS: { default: 900, max: 3600 },
    inheritUserEnvironment: false,
    closeTimeoutS: 1800,
  });
  assert.deepEqual(emptyConfig().queue, {
    maxConcurrent: null,
    resumeSession: false,
    leaseHeartbeatS: 5,
    keepAwake: "auto",
    bashTimeoutS: { default: 900, max: 3600 },
    inheritUserEnvironment: false,
    closeTimeoutS: 1800,
  });
});

test("queue.inheritUserEnvironment only accepts a literal true, so a job stays isolated by accident-proof default", () => {
  assert.equal(normalizeConfig({ queue: { inheritUserEnvironment: true } }).queue.inheritUserEnvironment, true);
  for (const raw of ["true", 1, "yes", {}, null, undefined]) {
    assert.equal(
      normalizeConfig({ queue: { inheritUserEnvironment: raw } }).queue.inheritUserEnvironment,
      false,
      `\`${String(raw)}\` turned it on`,
    );
  }
  assert.equal(normalizeConfig({}).queue.inheritUserEnvironment, false, "a missing key must default to false");
});

test("queue.maxConcurrent is an opt-in ceiling: only a positive integer sets one", () => {
  assert.equal(normalizeConfig({ queue: { maxConcurrent: 3 } }).queue.maxConcurrent, 3);
  for (const raw of [0, -1, "2", 1.5, null, undefined]) {
    assert.equal(normalizeConfig({ queue: { maxConcurrent: raw } }).queue.maxConcurrent, null, `\`${String(raw)}\` became a ceiling`);
  }
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

test("queue.keepAwake only accepts its three documented modes, anything else falls back to auto", () => {
  for (const valid of ["auto", "always", "off"]) {
    assert.equal(normalizeConfig({ queue: { keepAwake: valid } }).queue.keepAwake, valid);
  }
  for (const invalid of ["ALWAYS", "sometimes", 1, true, {}, null, undefined]) {
    assert.equal(normalizeConfig({ queue: { keepAwake: invalid } }).queue.keepAwake, "auto", `\`${String(invalid)}\` was accepted`);
  }
  assert.equal(normalizeConfig({}).queue.keepAwake, "auto", "a missing key must default to auto");
});

test("queue.bashTimeoutS accepts two positive integers with max >= default, otherwise falls back to 900/3600", () => {
  assert.deepEqual(normalizeConfig({ queue: { bashTimeoutS: { default: 60, max: 120 } } }).queue.bashTimeoutS, { default: 60, max: 120 });
  assert.deepEqual(normalizeConfig({ queue: { bashTimeoutS: { default: 600, max: 600 } } }).queue.bashTimeoutS, { default: 600, max: 600 });
  for (const raw of [
    { default: "600", max: 1200 },
    { default: 0, max: 1200 },
    { default: -1, max: 1200 },
    { default: 600, max: 300 },
    { default: 600 },
    { max: 1200 },
    {},
    null,
    undefined,
    "900",
  ]) {
    assert.deepEqual(
      normalizeConfig({ queue: { bashTimeoutS: raw } }).queue.bashTimeoutS,
      { default: 900, max: 3600 },
      `\`${JSON.stringify(raw)}\` was accepted as bash timeouts`,
    );
  }
  assert.deepEqual(normalizeConfig({}).queue.bashTimeoutS, { default: 900, max: 3600 }, "a missing key must default to 900/3600");
});

test("queue.closeTimeoutS accepts an integer between 60 and 3600, otherwise falls back to 1800", () => {
  for (const valid of [60, 600, 3600]) {
    assert.equal(normalizeConfig({ queue: { closeTimeoutS: valid } }).queue.closeTimeoutS, valid, String(valid));
  }
  for (const invalid of [0, 59, 3601, -600, 90.5, "600", null, {}, undefined]) {
    assert.equal(normalizeConfig({ queue: { closeTimeoutS: invalid } }).queue.closeTimeoutS, 1800, `\`${String(invalid)}\` was accepted`);
  }
  assert.equal(emptyConfig().queue.closeTimeoutS, 1800);
});

test("normalizeConfig keeps every top-level key it does not own verbatim, the v17 registry included", () => {
  const raw = { projects: { api: { path: "/tmp/api", org: "acme" } }, orgs: { acme: { displayName: "Acme" } }, handAdded: { keep: [1, 2] } };
  const config = normalizeConfig(raw);
  assert.deepEqual(config.projects, raw.projects);
  assert.deepEqual(config.orgs, raw.orgs);
  assert.deepEqual(config.handAdded, { keep: [1, 2] });
  assert.equal(config.defaultOrg, null);
  assert.deepEqual(normalizeConfig("nonsense"), emptyConfig());
});

test("normalizeSecrets keeps only well-formed connection entries", () => {
  const secrets = normalizeSecrets({ connections: { gh: { type: "github", token: "t" }, bad: { token: "t" } } });
  assert.deepEqual(Object.keys(secrets.connections), ["gh"]);
  assert.deepEqual(normalizeSecrets(undefined), emptySecrets());
});

test("a `__proto__` key in a hand-edited file never reaches the prototype of the built maps", () => {
  const raw = JSON.parse('{"orgConnections":{"__proto__":{"github":"gh"},"01J0000000000000000000ACME":{"__proto__":"x","github":"gh"}}}');
  const config = normalizeConfig(raw);
  assert.equal(config.orgConnections.github, undefined);
  assert.equal(Object.getPrototypeOf(config.orgConnections), null);
  assert.equal(Object.getPrototypeOf(config.orgConnections["01J0000000000000000000ACME"]), null);
  assert.equal(config.orgConnections["01J0000000000000000000ACME"].github, "gh");
  assert.equal({}.github, undefined);
});

test("a `__proto__` connection in secrets.json stays inert data instead of answering lookups", () => {
  const secrets = normalizeSecrets(JSON.parse('{"connections":{"__proto__":{"type":"github","token":"t"}}}'));
  assert.equal(secrets.connections.type, undefined);
  assert.equal(secrets.connections.token, undefined);
  assert.equal(secrets.connections.nope, undefined);
  assert.equal(Object.getPrototypeOf(secrets.connections), null);
  assert.deepEqual(Object.keys(secrets.connections), ["__proto__"]);
});

test("a file written by a newer nightqueue is refused instead of silently downgraded", () => {
  assert.throws(() => normalizeConfig({ version: 2, orgs: {} }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /config\.json was written by a newer nightqueue \(version 2\)/);
    assert.match(err.message, /supports version 1/);
    return true;
  });
  assert.throws(() => normalizeSecrets({ version: 5, connections: {} }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /secrets\.json was written by a newer nightqueue \(version 5\)/);
    return true;
  });
  assert.equal(normalizeConfig({ version: 1, orgs: {} }).version, 1);
});
