import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { newId } from "../../src/config/ids.mjs";
import { operatorConsentPath, operatorLogPath } from "../../src/config/paths.mjs";
import { registeredCheckouts } from "../../src/memory/registry-access.mjs";
import { connectionScope, consentCovers, liveConsents, operatorSession, recordConsent } from "../../src/queue/operator-consent.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// A home with one registered checkout and the arguments of a consent in a fresh session.
function consentFixture(t) {
  const env = makeHome(t, "operator-consent");
  const checkout = makeProject(t, env, "alpha");
  const project = registeredCheckouts(env).find((row) => row.name === "alpha");
  return { env, checkout, project, session: newId() };
}

test("operatorSession answers the pinned session id, and null for a bad id or inside a job", () => {
  const id = newId();
  assert.equal(operatorSession({ NIGHTQUEUE_OPERATOR_SESSION: id }), id);
  assert.equal(operatorSession({ NIGHTQUEUE_OPERATOR_SESSION: "1234" }), null);
  assert.equal(operatorSession({ NIGHTQUEUE_OPERATOR_SESSION: id, NIGHTQUEUE_JOB_ID: "7" }), null);
  assert.equal(operatorSession({}), null);
});

test("a grant lands under the home per session with the quoted answer, and the session log gets one line per consent", (t) => {
  const { env, checkout, project, session } = consentFixture(t);
  const { consent, line } = recordConsent({ session, project, kind: "edit", scope: join(checkout, "src"), reason: "fix the parser", answer: 'yes, "edit src"', env });
  assert.equal(consent.answer, 'yes, "edit src"');
  assert.equal(consent.project_id, project.id);
  assert.ok(existsSync(operatorConsentPath(session, env)));
  assert.equal(existsSync(join(checkout, ".nightqueue")), false);
  assert.match(line, /^\S+ consent edit .*src · alpha · "yes, "edit src""$/);
  recordConsent({ session, project, kind: "run", scope: "cd /x && npm test", reason: "run the suite", answer: "ok", env });
  const log = readFileSync(operatorLogPath(session, env), "utf8").trim().split("\n");
  assert.equal(log.length, 2);
  assert.match(log[1], / consent run npm test · alpha · "ok"$/);
  assert.deepEqual(liveConsents(session, env).map((grant) => grant.kind), ["edit", "run"]);
});

test("a grant needs the person's answer and a reason, a project but for connection-write, and a known kind", (t) => {
  const { env, checkout, project, session } = consentFixture(t);
  const base = { session, project, kind: "edit", scope: checkout, reason: "r", answer: "yes", env };
  assert.throws(() => recordConsent({ ...base, answer: " " }), /`answer` is required/);
  assert.throws(() => recordConsent({ ...base, reason: undefined }), /`reason` is required/);
  assert.throws(() => recordConsent({ ...base, project: null }), /requires `project`/);
  assert.throws(() => recordConsent({ ...base, kind: "delete" }), /`kind` is one of/);
  assert.throws(() => recordConsent({ ...base, session: "nope" }), /only a `nightqueue open` session/);
  assert.throws(() => recordConsent({ ...base, scope: "src" }), /absolute path/);
  const { consent } = recordConsent({ ...base, project: null, kind: "connection-write", scope: "team-chat patch /messages/1" });
  assert.equal(consent.scope, "team-chat PATCH messages/1");
  assert.throws(() => recordConsent({ ...base, kind: "connection-write", scope: "team-chat DELETE x" }), /POST\|PATCH\|PUT/);
});

test("a revoke withdraws every grant of the same scope, logs a line, and is refused when nothing matches", (t) => {
  const { env, checkout, project, session } = consentFixture(t);
  const grant = { session, project, kind: "edit", scope: checkout, reason: "r", answer: "yes", env };
  recordConsent(grant);
  recordConsent(grant);
  const target = { kind: "edit", target: join(checkout, "a.mjs") };
  assert.equal(consentCovers(session, target, env), true);
  const { revoked, line } = recordConsent({ ...grant, revoke: true, answer: undefined });
  assert.equal(revoked, 2);
  assert.match(line, / revoke edit .* · alpha$/);
  assert.equal(consentCovers(session, target, env), false);
  assert.throws(() => recordConsent({ ...grant, revoke: true }), /no live consent .*the live ones: none/);
});

test("an unparsable line of the record is skipped, and a consent of another session never counts", (t) => {
  const { env, checkout, project, session } = consentFixture(t);
  recordConsent({ session, project, kind: "edit", scope: checkout, reason: "r", answer: "yes", env });
  appendFileSync(operatorConsentPath(session, env), "not json\n[1]\n");
  assert.equal(liveConsents(session, env).length, 1);
  assert.equal(consentCovers(newId(), { kind: "edit", target: join(checkout, "a.mjs") }, env), false);
  assert.equal(consentCovers(null, { kind: "edit", target: join(checkout, "a.mjs") }, env), false);
});

test("connectionScope writes the method upper-case and the path without its slash, `-` for none", () => {
  assert.equal(connectionScope({ connection: "gh", method: "post", path: "/repos/x/issues" }), "gh POST repos/x/issues");
  assert.equal(connectionScope({ connection: "linear", method: "POST", path: "" }), "linear POST -");
});
