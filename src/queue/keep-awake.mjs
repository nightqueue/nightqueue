import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { loadConfig } from "../config/store.mjs";

// Tells whether the path exists and is executable by the current user; this never runs it.
function isRunnable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolves the `caffeinate` binary: an operator override first, then the PATH; absence never throws, and nothing is
// executed to find out - only the filesystem is asked.
export function resolveCaffeinateBin(env = process.env) {
  try {
    const override = String(env?.NIGHTQUEUE_CAFFEINATE_BIN ?? "").trim();
    if (override) return isRunnable(override) ? override : null;
    for (const dir of String(env?.PATH ?? "").split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, "caffeinate");
      if (isRunnable(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

// The `queue.keepAwake` mode the operator configured, already normalized by config/schema.mjs.
export function keepAwakeMode(env = process.env) {
  return loadConfig(env, { warn: () => {} }).queue?.keepAwake ?? "auto";
}

const DEFAULT_DEPS = {
  spawnImpl: spawn,
  resolveBinImpl: resolveCaffeinateBin,
  platform: process.platform,
};

// Merges the injected seams over the real implementations, the way the runner already does for its own deps.
function withDefaults(deps) {
  const merged = { ...DEFAULT_DEPS };
  for (const [key, value] of Object.entries(deps ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

// The argv of one caffeinate hold, or null when nothing should be held at all: any platform but darwin, and
// `queue.keepAwake: "off"`. The runner hold only stays armed on AC power (`-s`) unless the operator asked for
// `always` (`-i`); the job hold is always `-i`, so a job burning tokens is never put to sleep on battery either.
// `-d` never appears here: the display is always allowed to sleep.
export function keepAwakeArgs({ platform, mode, kind, pid }) {
  if (platform !== "darwin" || mode === "off") return null;
  const flag = kind === "job" || mode === "always" ? "-i" : "-s";
  return [flag, "-w", String(pid)];
}

// Warns once, on stderr, that the machine could not be kept awake; a detached runner's stderr is its own log file,
// and this never costs the runner nor the job it was protecting.
function warnKeepAwakeFailure(reason) {
  process.stderr.write(`nightqueue: could not keep the machine awake (${reason}); continuing without it\n`);
}

// Spawns one caffeinate hold tied to the life of the given pid (`-w` makes it exit on its own, nothing to clean up),
// detached from this process's own stdio; a binary that cannot be found, a spawn that throws and one that fails
// asynchronously all warn once and never throw out of here.
function spawnHold({ pid, kind, env, deps }) {
  const { spawnImpl, resolveBinImpl, platform } = withDefaults(deps);
  const args = keepAwakeArgs({ platform, mode: keepAwakeMode(env), kind, pid });
  if (!args) return;
  const bin = resolveBinImpl(env);
  if (!bin) {
    warnKeepAwakeFailure("caffeinate not found");
    return;
  }
  try {
    const child = spawnImpl(bin, args, { detached: true, stdio: "ignore" });
    child?.on?.("error", (err) => warnKeepAwakeFailure(err?.message ?? String(err)));
    child?.unref?.();
  } catch (err) {
    warnKeepAwakeFailure(err?.message ?? String(err));
  }
}

// Holds the machine awake for the whole life of this runner process.
export function holdRunnerAwake({ pid, env = process.env, deps = {} } = {}) {
  spawnHold({ pid, kind: "runner", env, deps });
}

// Holds the machine awake, on battery too, for the life of one job's child process.
export function holdJobAwake({ pid, env = process.env, deps = {} } = {}) {
  spawnHold({ pid, kind: "job", env, deps });
}
