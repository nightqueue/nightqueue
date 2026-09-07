import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { marketplaceIsCurrent } from "../../src/host/plugin.mjs";
import { makeHostEnv } from "../../test-support/host.mjs";

// Marketplace entry of a third-party package that happens to share the "nightshift" name, with no local path at all.
const ALIEN_ENTRY = {
  source: "https://github.com/someone-else/tool",
  installLocation: "https://github.com/someone-else/tool",
  lastUpdated: 1700000000000,
};

// Context that captures stdout so the setup report can be asserted on.
function makeCtx(env) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {} };
  return { ctx, out };
}

// Writes the known_marketplaces.json fixture the host would carry for a colliding marketplace.
function writeAlienMarketplace(configDir) {
  const dir = join(configDir, "plugins");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "known_marketplaces.json");
  writeFileSync(path, `${JSON.stringify({ nightshift: ALIEN_ENTRY }, null, 2)}\n`);
  return path;
}

test("marketplaceIsCurrent must not call a name collision (no local path) 'this package'", () => {
  // Correct behavior: an entry with no path pointing at this package root is NOT "current" just because the key matched.
  assert.equal(marketplaceIsCurrent(ALIEN_ENTRY), false);
});

test("setup must fix a marketplace registered under our name but pointing elsewhere, not call it 'already present'", async (t) => {
  const host = makeHostEnv(t, "plugin-marketplace-collision");
  const marketplacePath = writeAlienMarketplace(host.configDir);
  const { ctx, out } = makeCtx(host.env);

  await run(["setup"], ctx);

  // Correct behavior: setup detects the collision and re-registers the marketplace against this package.
  const calls = host.calls();
  assert.ok(
    calls.some((call) => call[0] === "plugin" && call[1] === "marketplace" && call[2] === "add"),
    `setup never tried to fix the colliding marketplace; calls were: ${JSON.stringify(calls)}`,
  );

  // Correct behavior: once fixed, the known_marketplaces.json entry points at this package, not at the alien source.
  const after = JSON.parse(readFileSync(marketplacePath, "utf8"));
  assert.equal(after.nightshift.source, host.runtimePackage);

  assert.equal(out.includes(`plugin marketplace: already present`), false, out.join("\n"));
});
