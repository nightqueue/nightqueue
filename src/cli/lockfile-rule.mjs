import { basename, dirname, join } from "node:path";
import { runGit } from "../host/git.mjs";
import { frozenInstall, regenerateCommand } from "./frozen-install.mjs";
import { managerOfLockfile } from "./detect.mjs";

const MANIFEST = "package.json";
const NOT_PUBLISHABLE = "a dependency lockfile";

// True when the worktree file exists and differs from the same path at the base ref (or is new there).
function changedAgainstBase({ cwd, env, base, path }) {
  const now = runGit({ args: ["hash-object", "--", path], cwd, env });
  if (!now.ok) return false;
  const before = runGit({ args: ["rev-parse", "--verify", "--quiet", `${base}:${path}`], cwd, env });
  return !before.ok || before.stdout.trim() !== now.stdout.trim();
}

// The rule that decides which lockfiles a publish may carry; `reasonFor(path, set)` answers why a path is refused, or null.
export function lockfileRule({ cwd, env, baseRef, install = frozenInstall }) {
  const installs = new Map();

  const installOf = (path, manager) => {
    if (!installs.has(path)) installs.set(path, install({ manager, cwd: join(cwd, dirname(path)), env }));
    return installs.get(path);
  };

  return {
    reasonFor(path, set) {
      const manager = managerOfLockfile(basename(path));
      if (manager === null) return null;
      const manifest = join(dirname(path), MANIFEST);
      if (!set.has(manifest) || !changedAgainstBase({ cwd, env, base: baseRef(), path: manifest })) return NOT_PUBLISHABLE;
      if (!changedAgainstBase({ cwd, env, base: baseRef(), path })) {
        return `manifest changed but the lockfile did not: run ${regenerateCommand(manager)}`;
      }
      const installed = installOf(path, manager);
      return installed.ok ? null : `\`${installed.command}\` failed: ${installed.tail}`;
    },
  };
}
