import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SESSIONS_DIR = join(ROOT, "src", "sessions");
const HOST_DIR = join(ROOT, "src", "host");
const IMPORT_SPECIFIERS = [
  /\bimport\s[^'"]*?from\s*["']([^"']+)["']/g,
  /\bexport\s[^'"]*?from\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

// The `.mjs` files under a directory, recursively.
function moduleFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return moduleFiles(path);
    return entry.name.endsWith(".mjs") ? [path] : [];
  });
}

// The repository-relative paths a module imports through a relative specifier, static, re-export or dynamic.
function relativeImports(file) {
  const source = readFileSync(file, "utf8");
  const specifiers = IMPORT_SPECIFIERS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
  return specifiers.filter((spec) => spec.startsWith(".")).map((spec) => relative(ROOT, resolve(dirname(file), spec)));
}

// Tells whether a repository-relative path is in the frozen mechanics: src/queue or a src/cli/run* module.
function isForbidden(path) {
  return path.startsWith(join("src", "queue") + "/") || /^src\/cli\/run[^/]*\.mjs$/.test(path);
}

test("nothing under src/sessions imports src/queue or src/cli/run*", () => {
  const files = moduleFiles(SESSIONS_DIR);
  assert.ok(files.length >= 3, `expected at least registry, launch and agents, found ${files.length}`);
  for (const file of files) {
    const forbidden = relativeImports(file).filter(isForbidden);
    assert.deepEqual(forbidden, [], `${relative(ROOT, file)} imports the frozen mechanics`);
  }
});

test("every src/host module src/sessions imports directly imports nothing from src/queue", () => {
  const hostModules = new Set(moduleFiles(SESSIONS_DIR).flatMap(relativeImports).filter((path) => path.startsWith(join("src", "host") + "/")));
  assert.ok(hostModules.size > 0);
  for (const path of hostModules) {
    const forbidden = relativeImports(join(ROOT, path)).filter(isForbidden);
    assert.deepEqual(forbidden, [], `${path} imports src/queue`);
  }
  assert.ok(moduleFiles(HOST_DIR).length > 0);
});

test("the boundary scan sees each import form", () => {
  const sample = join(SESSIONS_DIR, "registry.mjs");
  assert.ok(relativeImports(sample).includes(join("src", "config", "paths.mjs")));
  assert.equal(isForbidden("src/queue/registry.mjs"), true);
  assert.equal(isForbidden("src/cli/run.mjs"), true);
  assert.equal(isForbidden("src/cli/runner-x.mjs"), true);
  assert.equal(isForbidden("src/cli/chat.mjs"), false);
});
