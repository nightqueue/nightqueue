import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runsDir, runsIdMarkerPath } from "../../config/paths.mjs";
import * as registry from "../registry.mjs";

// The v18 move of the run directories: `runs/<project name>/<slug>` becomes `runs/<project id>/<slug>`, entry by entry, never
// overwriting what is already under the id, then `runs/.by-id` marks the move done. Per open, idempotent and racer-tolerant.

// Tells whether the run directories still wait to be moved from project names to project ids.
function runsMovePending(env) {
  return existsSync(runsDir(env)) && !existsSync(runsIdMarkerPath(env));
}

// The directories of runs/ still named after a registered project, each with the id it moves to.
function namedRunDirs(db, env) {
  const idByName = new Map(registry.listProjects(db).map((project) => [project.name, project.id]));
  return readdirSync(runsDir(env))
    .filter((entry) => !entry.startsWith(".") && idByName.has(entry) && idByName.get(entry) !== entry)
    .map((name) => ({ name, id: idByName.get(name) }));
}

// State of a path without following a link, or null when nothing is there.
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

// An error with the code of a target somebody already holds.
function takenError(target) {
  return Object.assign(new Error(`${target} already exists`), { code: "EEXIST" });
}

// Removes an empty directory this step created, leaving it when anything was written into it meanwhile.
function removeQuietly(dir) {
  try {
    rmdirSync(dir);
  } catch {
    return;
  }
}

// Moves a directory onto a target claimed first with a non-recursive mkdir, so a target that already exists is never replaced.
function moveDirectory(source, target) {
  mkdirSync(target);
  try {
    renameSync(source, target);
  } catch (err) {
    removeQuietly(target);
    throw err;
  }
}

// Moves one entry of a project's run directory under the project's id, refusing a target that already exists.
function moveEntry(source, target) {
  const stats = lstatSync(source);
  if (stats.isDirectory()) return moveDirectory(source, target);
  if (lstatOrNull(target)) throw takenError(target);
  renameSync(source, target);
}

// Moves one entry, keeping it with one warning when it cannot move; an entry a racer already moved is not a failure.
function moveEntryOrWarn(source, target, warn) {
  try {
    moveEntry(source, target);
  } catch (err) {
    if (err?.code === "ENOENT" || !lstatOrNull(source)) return;
    const reason = err?.code === "EEXIST" || err?.code === "ENOTEMPTY" ? `${target} already exists` : String(err?.message ?? err);
    warn(`nightqueue: warning: kept ${source} where it is: ${reason}; move its content by hand`);
  }
}

// Removes the emptied name directory; one still holding a kept entry stays, and one a racer removed is fine.
function removeEmptied(dir) {
  try {
    rmdirSync(dir);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTEMPTY" || err?.code === "EEXIST") return;
    throw err;
  }
}

// Moves every entry of `runs/<name>/` into `runs/<id>/`; a name that is not a plain directory is kept with one warning.
function moveProjectRuns({ name, id }, env, warn) {
  const source = join(runsDir(env), name);
  const stats = lstatOrNull(source);
  if (!stats) return;
  if (!stats.isDirectory()) {
    warn(`nightqueue: warning: kept ${source} where it is: it is not a plain directory; move its runs to ${join(runsDir(env), id)} by hand`);
    return;
  }
  const target = join(runsDir(env), id);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) moveEntryOrWarn(join(source, entry), join(target, entry), warn);
  removeEmptied(source);
}

// Moves the runs of one project, answering false (with one warning) when it failed and the step must run again on the next open.
function movedProjectRuns(named, env, warn) {
  try {
    moveProjectRuns(named, env, warn);
    return true;
  } catch (err) {
    warn(`nightqueue: warning: could not move the runs of project \`${named.name}\` to runs/${named.id}: ${err?.message ?? err}`);
    return false;
  }
}

// Moves the run directories of every registered project from its name to its id, then writes the marker that ends the step.
export function moveRunsToIds(db, env, { warn }) {
  if (!runsMovePending(env)) return;
  const outcomes = namedRunDirs(db, env).map((named) => movedProjectRuns(named, env, warn));
  if (outcomes.every(Boolean)) writeFileSync(runsIdMarkerPath(env), `${new Date().toISOString()}\n`);
}
