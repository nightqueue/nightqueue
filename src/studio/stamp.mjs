import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const STUDIO_FILES = ["studio/index.html", "studio/vite.config.mts", "studio/tsconfig.json"];
const STUDIO_SOURCE_DIR = "studio/src";
const DIST_DIR = "studio/dist";
const STAMP_FILE = "studio/dist/.stamp.json";

// Every file under a directory, as paths relative to the root with forward slashes; a missing directory has none.
function filesUnder(root, dir) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join("/"));
}

// The installed version of every devDependency the manifest declares, read from the lockfile; the build depends on them too.
function devDependencyVersions(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const names = Object.keys(manifest.devDependencies ?? {}).sort();
  return names.map((name) => `${name}@${lock.packages?.[`node_modules/${name}`]?.version ?? "missing"}`);
}

// The sha256 of the studio sources (index.html, src/**, the Vite and TypeScript configs) and the devDependency versions, stable across checkouts.
export function studioSourceHash(root) {
  const files = [...STUDIO_FILES.filter((file) => existsSync(join(root, file))), ...filesUnder(root, STUDIO_SOURCE_DIR)].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  hash.update(devDependencyVersions(root).join("\n"));
  return hash.digest("hex");
}

// Writes the stamp of a fresh build: the source hash the dist was built from.
export function writeStudioStamp(root) {
  const hash = studioSourceHash(root);
  writeFileSync(join(root, STAMP_FILE), `${JSON.stringify({ hash, builtAt: new Date().toISOString() }, null, 2)}\n`);
  return hash;
}

// The hash a stamp records, or null when it cannot be read.
function stampedHash(root) {
  try {
    const hash = JSON.parse(readFileSync(join(root, STAMP_FILE), "utf8"))?.hash;
    return typeof hash === "string" && hash ? hash : null;
  } catch {
    return null;
  }
}

// Checks that the dist exists, carries a stamp, and was built from the sources on disk now: `{ ok, reason, hash }`.
export function checkStudioStamp(root) {
  if (!existsSync(join(root, DIST_DIR, "index.html"))) return { ok: false, reason: "studio/dist is missing; run `npm run studio:build`", hash: null };
  const stamped = stampedHash(root);
  if (stamped === null) return { ok: false, reason: "studio/dist carries no stamp; run `npm run studio:build`", hash: null };
  const hash = studioSourceHash(root);
  if (stamped !== hash) return { ok: false, reason: "studio/dist is stale: the studio sources changed since it was built; run `npm run studio:build`", hash };
  return { ok: true, reason: null, hash };
}
