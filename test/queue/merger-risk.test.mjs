import assert from "node:assert/strict";
import { test } from "node:test";
import { mergerProfileOf } from "../../src/queue/close.mjs";
import { DEFAULT_MERGER_RISK, effectiveRisk, requireRiskPattern, riskPatternMatches } from "../../src/queue/merger-risk.mjs";
import { MERGER_MODEL } from "../../src/queue/routing.mjs";

test("the default risk list is the generic package manifest and lockfile list, naming no repository's own paths", () => {
  assert.deepEqual([...DEFAULT_MERGER_RISK], ["package.json", "*-lock.json", "*.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "Gemfile.lock"]);
  assert.equal(DEFAULT_MERGER_RISK.some((pattern) => pattern.includes("src/")), false);
  assert.equal(effectiveRisk(null), DEFAULT_MERGER_RISK);
  assert.deepEqual(effectiveRisk([]), []);
});

test("a pattern without a slash matches the file name at any depth, one with a slash the whole path", () => {
  const cases = [
    ["*.lock", "yarn.lock", true],
    ["*.lock", "a/b/c.lock", true],
    ["*.lock", "a.lock.md", false],
    ["*-lock.json", "web/package-lock.json", true],
    ["src/memory/schema.mjs", "src/memory/schema.mjs", true],
    ["src/memory/schema.mjs", "lib/src/memory/schema.mjs", false],
    ["src/memory/schema.mjs", "./src/memory/schema.mjs", true],
    ["src/memory/migration/**", "src/memory/migration/v3.mjs", true],
    ["src/memory/migration/**", "src/memory/migration/a/b.mjs", true],
    ["src/memory/migration/**", "src/memory/migrations.mjs", false],
    ["src/*/x.mjs", "src/a/x.mjs", true],
    ["src/*/x.mjs", "src/a/b/x.mjs", false],
    ["**/fixtures/*.json", "fixtures/a.json", true],
    ["**/fixtures/*.json", "test/deep/fixtures/a.json", true],
    ["src/**/gen.mjs", "src/gen.mjs", true],
    ["v?.mjs", "v3.mjs", true],
    ["v?.mjs", "v10.mjs", false],
    ["a+(b).txt", "a+(b).txt", true],
    ["a+(b).txt", "aa(b).txt", false],
    ["file.[ch]", "file.c", false],
  ];
  for (const [pattern, path, expected] of cases) assert.equal(riskPatternMatches(path, pattern), expected, `${pattern} vs ${path}`);
  assert.equal(riskPatternMatches(null, "*.lock"), false);
  assert.equal(riskPatternMatches("a.lock", ""), false);
});

test("a directory pattern, with or without `./` or a trailing slash, protects every file under it", () => {
  for (const given of ["src/memory/migration", "src/memory/migration/", "./src/memory/migration"]) {
    const pattern = requireRiskPattern(given);
    assert.equal(pattern, "src/memory/migration", given);
    assert.equal(riskPatternMatches("src/memory/migration/v3.mjs", pattern), true, given);
    assert.equal(riskPatternMatches("src/memory/migration/v3.mjs", given), true, `${given} as stored`);
    assert.equal(riskPatternMatches("src/memory/migrations.mjs", given), false, given);
  }
  assert.equal(requireRiskPattern("./src/x.mjs"), "src/x.mjs");
  assert.equal(riskPatternMatches("vendor/lib/a.js", "vendor"), true);
  assert.equal(riskPatternMatches("src/vendored.js", "vendor"), false);
  assert.throws(() => requireRiskPattern("./"), /cannot be empty/);
});

test("`**` crosses line-breaking characters in a path, and nested `**/` answers in linear time", () => {
  assert.equal(riskPatternMatches("src/a\nb.mjs", "src/**"), true);
  assert.equal(riskPatternMatches("src/a b/x.mjs", "src/**/x.mjs"), true);
  assert.equal(riskPatternMatches("a\rb/Cargo.lock", "**/*.lock"), true);
  const started = Date.now();
  assert.equal(riskPatternMatches(`${Array(60).fill("a").join("/")}/y.mjs`, `${"**/".repeat(60)}x.lock`), false);
  assert.ok(Date.now() - started < 1000);
});

test("a risk pattern is trimmed, and an empty, absolute, parent-escaping, control-carrying or overlong one is refused", () => {
  assert.equal(requireRiskPattern("  src/**  "), "src/**");
  const refused = [
    ["", /cannot be empty/],
    ["   ", /cannot be empty/],
    ["/abs", /must be relative/],
    ["../x", /\.\. segment/],
    ["a/../b", /\.\. segment/],
    ["a\nb", /control character/],
    ["x".repeat(201), /over 200 characters/],
    [42, /must be a text glob/],
  ];
  for (const [value, message] of refused) assert.throws(() => requireRiskPattern(value), message, JSON.stringify(value));
});

test("the close reads the project's risk list, the default without a project, and fails closed when the read throws", async () => {
  const store = (mergerRisk) => ({ projects: { mergerRisk, agents: async () => null } });
  assert.deepEqual(await mergerProfileOf(store(async () => ["src/**"]), { project_id: "p1" }), { risk: ["src/**"], model: MERGER_MODEL });
  assert.deepEqual(await mergerProfileOf(store(async () => null), { project_id: "p1" }), { risk: DEFAULT_MERGER_RISK, model: MERGER_MODEL });
  assert.deepEqual(await mergerProfileOf(store(async () => { throw new Error("locked"); }), { project_id: "p1" }), { risk: null, model: MERGER_MODEL });
  assert.deepEqual(await mergerProfileOf(store(async () => { throw new Error("never read"); }), { project_id: null }), { risk: DEFAULT_MERGER_RISK, model: MERGER_MODEL });
});

test("the close reads the project's merger model, the default when the agents cannot be read", async () => {
  const store = (agents) => ({ projects: { mergerRisk: async () => null, agents } });
  assert.equal((await mergerProfileOf(store(async () => ({ merger: { model: "haiku" } })), { project_id: "p1" })).model, "haiku");
  assert.equal((await mergerProfileOf(store(async () => ({ merger: { model: "gpt" } })), { project_id: "p1" })).model, MERGER_MODEL);
  assert.equal((await mergerProfileOf(store(async () => { throw new Error("locked"); }), { project_id: "p1" })).model, MERGER_MODEL);
});
