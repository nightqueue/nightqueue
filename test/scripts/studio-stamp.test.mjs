import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkStudioStamp, studioSourceHash, writeStudioStamp } from "../../scripts/studio-stamp.mjs";
import { makeDir } from "../../test-support/memory.mjs";

// A repository root with the studio sources, a manifest and a lockfile, the inputs of the stamp.
function makeRoot(t) {
  const root = makeDir(t, "studio-stamp");
  mkdirSync(join(root, "studio", "src", "lib"), { recursive: true });
  writeFileSync(join(root, "studio", "index.html"), "<div id=root></div>");
  writeFileSync(join(root, "studio", "tsconfig.json"), "{}");
  writeFileSync(join(root, "studio", "src", "main.tsx"), "export {};");
  writeFileSync(join(root, "studio", "src", "lib", "format.ts"), "export const a = 1;");
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { vite: "^8.0.0" } }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/vite": { version: "8.3.2" } } }));
  return root;
}

// A built dist of that root, stamped with its current sources.
function build(root) {
  mkdirSync(join(root, "studio", "dist"), { recursive: true });
  writeFileSync(join(root, "studio", "dist", "index.html"), "<!doctype html>");
  return writeStudioStamp(root);
}

test("the source hash is stable, and changes with a source file or a devDependency version", (t) => {
  const root = makeRoot(t);
  const first = studioSourceHash(root);
  assert.equal(studioSourceHash(root), first);
  writeFileSync(join(root, "studio", "src", "lib", "format.ts"), "export const a = 2;");
  const edited = studioSourceHash(root);
  assert.notEqual(edited, first);
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/vite": { version: "8.4.0" } } }));
  assert.notEqual(studioSourceHash(root), edited);
});

test("a fresh build checks ok, and each refusal names its reason", (t) => {
  const root = makeRoot(t);
  assert.match(checkStudioStamp(root).reason, /missing/);
  const hash = build(root);
  assert.deepEqual(checkStudioStamp(root), { ok: true, reason: null, hash });
  writeFileSync(join(root, "studio", "src", "main.tsx"), "export const changed = true;");
  assert.match(checkStudioStamp(root).reason, /stale/);
  build(root);
  rmSync(join(root, "studio", "dist", ".stamp.json"));
  assert.match(checkStudioStamp(root).reason, /no stamp/);
});
