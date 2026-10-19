import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeDir } from "../../test-support/memory.mjs";
import { expo } from "../../src/integrations/expo.mjs";
import { ambientProviders, providerOf, retiredConnectionKinds } from "../../src/integrations/registry.mjs";

test("expo is an ambient provider with no stored connection, second among the cards", () => {
  assert.equal(providerOf("expo"), expo);
  assert.equal(expo.label, "Expo");
  assert.deepEqual(expo.card, { order: 2, icon: "expo" });
  assert.equal(expo.connection, undefined);
  assert.ok(ambientProviders().includes(expo));
  assert.ok(retiredConnectionKinds().includes("expo"));
});

test("the expo ambient login runs eas login through the resolved binary", () => {
  assert.deepEqual(expo.ambient.connect({ NIGHTQUEUE_EAS_BIN: "/opt/eas" }), { bin: "/opt/eas", args: ["login"] });
  assert.deepEqual(expo.ambient.connect({}), { bin: "eas", args: ["login"] });
  assert.equal(expo.ambient.command, "eas login");
  assert.equal(expo.ambient.hint, "nightqueue uses the machine's eas login; run `eas login`");
});

test("the expo ambient status reports a missing eas as not installed", async () => {
  const status = await expo.ambient.status({ PATH: process.env.PATH, NIGHTQUEUE_EAS_BIN: "/nonexistent/nightqueue-eas" });
  assert.deepEqual(status, { installed: false, authenticated: false, login: null, host: null });
});

test("expo detects a checkout by an eas.json at its root only, and never throws", (t) => {
  const app = makeDir(t, "expo-detect-app");
  writeFileSync(join(app, "eas.json"), "{}\n");
  const nested = makeDir(t, "expo-detect-nested");
  mkdirSync(join(nested, "mobile"));
  writeFileSync(join(nested, "mobile", "eas.json"), "{}\n");
  assert.equal(expo.detect(app), true);
  assert.equal(expo.detect(nested), false);
  assert.equal(expo.detect(join(app, "missing")), false);
  for (const odd of [null, undefined, "", 42, {}]) assert.equal(expo.detect(odd), false);
});

test("expo declares ota off and branch production, the branch refusing a leading dash", () => {
  assert.deepEqual({ type: expo.settings.ota.type, default: expo.settings.ota.default }, { type: "boolean", default: false });
  const branch = expo.settings.branch;
  assert.deepEqual([branch.type, branch.default], ["text", "production"]);
  for (const ok of ["production", "preview/v2", "release-1.2_x"]) assert.equal(branch.pattern.test(ok), true, ok);
  for (const bad of ["-x", "a b", "", "/main", "x".repeat(101)]) assert.equal(branch.pattern.test(bad), false, bad);
});
