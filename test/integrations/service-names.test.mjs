import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { providers } from "../../src/integrations/registry.mjs";

const GENERIC_FILES = [
  "src/queue/close.mjs",
  "src/queue/close-start.mjs",
  "src/queue/close-view.mjs",
  "src/mcp/tools.mjs",
  "src/mcp/phase-context.mjs",
  "src/queue/runner.mjs",
  "src/integrations/post-close.mjs",
  "src/integrations/enrich.mjs",
  "src/integrations/coverage.mjs",
  "src/integrations/origin.mjs",
  "src/integrations/settings.mjs",
  "src/integrations/connections.mjs",
];

// The text of a repository file.
function sourceOf(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").toLowerCase();
}

test("the generic close, queue, MCP and integration files name no provider of the registry but github", () => {
  const kinds = providers().map((provider) => provider.kind).filter((kind) => kind !== "github");
  assert.ok(kinds.length > 0, "the registry has no provider besides github; the guard would check nothing");
  const named = GENERIC_FILES.flatMap((path) => kinds.filter((kind) => sourceOf(path).includes(kind.toLowerCase())).map((kind) => `${path}: ${kind}`));
  assert.deepEqual(named, []);
});
