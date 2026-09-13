import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import {
  getDecision,
  getDecisionByNumber,
  listDecisions,
  recallDecisions,
  renderDecisionText,
  saveDecision,
  updateDecision,
} from "../../src/memory/decisions.mjs";
import { makeHome, makeOrg, makeProject } from "../../test-support/memory.mjs";

// Saves a decision of an owner with the fields every test would otherwise repeat.
function addDecision(env, { project, org, title, context = "the context", decision = "the decision", status }) {
  return saveDecision({ project, org, title, context, decision, status }, env);
}

// A home with the two orgs of the brief, one project in each.
function makeTwoOrgHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "acme-mobile-app", { org: "acme" });
  makeProject(t, env, "orbit-app", { org: "orbit" });
  return env;
}

// Owner label of a row, the way the CLI and the prompts print it.
function labelsOf(rows) {
  return rows.map((row) => (row.scope === "org" ? `${row.org}#${row.number}` : `#${row.number}`));
}

test("an org decision is numbered inside its org, independently of every project", (t) => {
  const env = makeTwoOrgHome(t, "decisions-org-number");
  assert.equal(addDecision(env, { project: "acme-mobile-app", title: "project first" }).number, 1);
  assert.equal(addDecision(env, { org: "acme", title: "org first" }).number, 1);
  assert.equal(addDecision(env, { org: "acme", title: "org second" }).number, 2);
  assert.equal(addDecision(env, { org: "orbit", title: "other org first" }).number, 1);
  assert.equal(addDecision(env, { project: "acme-mobile-app", title: "project second" }).number, 2);

  const db = openDb(env);
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO decisions (scope, org, number, title, context, decision) VALUES ('org', ?, 1, ?, ?, ?)")
        .run("acme", "t", "c", "d"),
    /UNIQUE constraint failed/,
  );
});

test("a write names project XOR org: both is refused, neither is refused, an unknown org names the existing ones", (t) => {
  const env = makeTwoOrgHome(t, "decisions-org-target");
  assert.throws(
    () => addDecision(env, { project: "acme-mobile-app", org: "acme", title: "both" }),
    /pass either `project` or `org`, never both/,
  );
  assert.throws(() => addDecision(env, { title: "neither" }), /pass `project` .* or `org`/);
  assert.throws(
    () => addDecision(env, { org: "ghost", title: "unknown org" }),
    /unknown org `ghost`; existing orgs: default, acme, orbit/,
  );
});

test("a project reads its own decisions and its org's, org first, and never another org's", async (t) => {
  const env = makeTwoOrgHome(t, "decisions-org-union");
  const own = addDecision(env, { project: "acme-mobile-app", title: "the app caches the plan" });
  const orgWide = addDecision(env, { org: "acme", title: "every acme repo caches the plan" });
  const foreign = addDecision(env, { org: "orbit", title: "orbit caches nothing" });

  const listed = listDecisions({ project: "acme-mobile-app" }, env);
  assert.deepEqual(listed.map((row) => row.id), [orgWide.id, own.id]);
  assert.deepEqual(labelsOf(listed), ["acme#1", "#1"]);
  assert.equal(listed.some((row) => row.id === foreign.id), false, "a orbit decision leaked into a acme project");

  const recalled = await recallDecisions({ query: "caches the plan", project: "acme-mobile-app" }, env);
  assert.equal(recalled[0].scope, "org", "the org rows must come first");
  assert.deepEqual(new Set(recalled.map((row) => row.id)), new Set([orgWide.id, own.id]));

  const other = await recallDecisions({ query: "caches", project: "orbit-app" }, env);
  assert.equal(other.some((row) => row.id === orgWide.id), false, "a acme decision leaked into a orbit project");
  assert.deepEqual(listDecisions({ org: "acme" }, env).map((row) => row.id), [orgWide.id], "an org read answers its rows alone");
});

test("an org decision renders and is read by its own number, while a project decision keeps printing `#7`", (t) => {
  const env = makeTwoOrgHome(t, "decisions-org-render");
  const project = addDecision(env, { project: "acme-mobile-app", title: "the app owns its cache" });
  const org = addDecision(env, { org: "acme", title: "one queue per product" });

  assert.equal(renderDecisionText(getDecision(project.id, env)).split("\n")[0], "#1 the app owns its cache (accepted)");
  assert.equal(renderDecisionText(getDecision(org.id, env)).split("\n")[0], "acme#1 one queue per product (accepted)");
  assert.equal(getDecisionByNumber({ org: "acme", number: 1 }, env).id, org.id);
  assert.equal(getDecisionByNumber({ project: "acme-mobile-app", number: 1 }, env).id, project.id);
});

test("superseded_by stays inside one owner: an org decision is never superseded by a project one", (t) => {
  const env = makeTwoOrgHome(t, "decisions-org-superseded");
  const project = addDecision(env, { project: "acme-mobile-app", title: "the app owns its cache" });
  const first = addDecision(env, { org: "acme", title: "one queue per product" });
  const second = addDecision(env, { org: "acme", title: "one queue per product, always" });
  const foreign = addDecision(env, { org: "orbit", title: "orbit decides alone" });

  assert.throws(() => updateDecision(first.id, { superseded_by: project.id }, env), /belongs to project `acme-mobile-app`/);
  assert.throws(() => updateDecision(first.id, { superseded_by: foreign.id }, env), /belongs to org `orbit`/);
  assert.equal(updateDecision(first.id, { superseded_by: second.id }, env).superseded_by, second.id);
});

test("an org with no project still owns decisions, and a project of the default org sees none of them", (t) => {
  const env = makeHome(t, "decisions-org-empty");
  makeProject(t, env, "alpha");
  makeOrg(env, "acme");
  const orphan = addDecision(env, { org: "acme", title: "nobody is registered here yet" });
  assert.equal(orphan.number, 1);
  assert.deepEqual(listDecisions({ project: "alpha" }, env), []);
  assert.deepEqual(listDecisions({ org: "acme" }, env).map((row) => row.number), [1]);
});
