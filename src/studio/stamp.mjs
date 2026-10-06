import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const STUDIO_FILES = ["studio/index.html", "studio/vite.config.mts", "studio/tsconfig.json"];
const STUDIO_SOURCE_DIR = "studio/src";
const STUDIO_PUBLIC_DIR = "studio/public";
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

// The sha256 of the studio sources (index.html, src/**, public/**, the Vite and TypeScript configs) and the devDependency versions, stable across checkouts.
export function studioSourceHash(root) {
  const files = [
    ...STUDIO_FILES.filter((file) => existsSync(join(root, file))),
    ...filesUnder(root, STUDIO_SOURCE_DIR),
    ...filesUnder(root, STUDIO_PUBLIC_DIR),
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  hash.update(devDependencyVersions(root).join("\n"));
  return hash.digest("hex");
}

// The sha256 of the lockfile of a root, or null when it has none.
export function lockSha256(root) {
  try {
    return createHash("sha256").update(readFileSync(join(root, "package-lock.json"))).digest("hex");
  } catch {
    return null;
  }
}

// The version a root's manifest declares, or null when it cannot be read.
function manifestVersion(root) {
  try {
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.version;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

// Reads the stamp of a root as an object, or null when it is missing or unreadable.
export function readStudioStampFile(root) {
  try {
    const stamp = JSON.parse(readFileSync(join(root, STAMP_FILE), "utf8"));
    return stamp && typeof stamp === "object" ? stamp : null;
  } catch {
    return null;
  }
}

// Writes the stamp of a fresh build: the source hash the dist was built from, the lockfile sha it was built with and the version it belongs to.
export function writeStudioStamp(root) {
  const hash = studioSourceHash(root);
  const stamp = { hash, builtAt: new Date().toISOString(), lock_sha256: lockSha256(root), version: manifestVersion(root) };
  writeFileSync(join(root, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
  return hash;
}

// The hash a stamp records, or null when it cannot be read.
function stampedHash(root) {
  const hash = readStudioStampFile(root)?.hash;
  return typeof hash === "string" && hash ? hash : null;
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
