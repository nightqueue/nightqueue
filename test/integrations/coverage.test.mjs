import { test } from "node:test";
import assert from "node:assert/strict";

import { originCoverage } from "../../src/integrations/coverage.mjs";
import { applyIntegrationChange } from "../../src/integrations/settings.mjs";

const ORG = "01J0000000000000000000ACME";
const LINEAR = { connections: { lin: { type: "linear", apiKey: "lin_api_secret" } } };

test("a home-scoped origin is covered by the home connection with no project integration and in any org", () => {
  for (const orgId of [null, ORG]) {
    const covered = originCoverage({ origin: { kind: "linear", ref: "MK-42" }, orgId, integrations: null, config: null, secrets: LINEAR });
    assert.deepEqual(covered, { kind: "linear", ref: "MK-42", connection: "lin", detail: null });
  }
});

test("a home-scoped origin without a connection is none, naming the home", () => {
  const covered = originCoverage({ origin: { kind: "linear", ref: "MK-42" }, orgId: ORG, integrations: null, config: null, secrets: { connections: {} } });
  assert.deepEqual(covered, { kind: "linear", ref: "MK-42", connection: "none", detail: "no linear connection in the home" });
});

test("an org-scoped origin still needs the project integration", () => {
  const covered = originCoverage({ origin: { kind: "sentry", ref: "4507" }, orgId: ORG, integrations: null, config: null, secrets: null });
  assert.equal(covered.detail, "project has no sentry integration");
});

test("a home-scoped kind has no project settings to set or unset", () => {
  for (const action of ["set", "unset"]) {
    assert.throws(() => applyIntegrationChange({ current: null, action, key: "linear.onClosed", value: "x" }), { message: "linear has no settings" });
  }
});
