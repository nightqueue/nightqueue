import { test } from "node:test";
import assert from "node:assert/strict";
import { profileArgs, SESSION_PROFILES } from "../../src/queue/session-profile.mjs";

test("profileArgs refuses an unknown kind, a missing kind and an inherited key as the kind", () => {
  assert.throws(() => profileArgs({ kind: "x" }), /unknown session profile kind "x"; expected one of job, merger, operator/);
  assert.throws(() => profileArgs(), /unknown session profile kind/);
  assert.throws(() => profileArgs({ kind: "toString" }), /unknown session profile kind "toString"/);
});

test("the session profiles are frozen, their order included", () => {
  assert.equal(Object.isFrozen(SESSION_PROFILES), true);
  for (const kind of ["job", "merger", "operator"]) {
    assert.equal(Object.isFrozen(SESSION_PROFILES[kind]), true, kind);
    assert.equal(Object.isFrozen(SESSION_PROFILES[kind].order), true, kind);
  }
});

test("an undefined value keeps the kind's default and a null one drops the flag", () => {
  const kept = profileArgs({ kind: "job", prompt: "p", strictMcp: undefined, settingSources: undefined });
  assert.deepEqual(kept, ["-p", "p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--setting-sources", "project"]);
  const dropped = profileArgs({ kind: "job", prompt: "p", strictMcp: false, settingSources: null });
  assert.deepEqual(dropped, ["-p", "p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose"]);
});
