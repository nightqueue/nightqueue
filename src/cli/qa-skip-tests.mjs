import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { citedTestPaths, isTestPath } from "../queue/check-contract.mjs";
import { worktreeOf } from "./run-context.mjs";

const TEST_CODE_EXTENSIONS = new Set(["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "py", "rb", "go", "rs", "java", "kt", "kts", "scala", "groovy", "swift", "c", "cc", "cpp", "cxx", "m", "mm", "cs", "fs", "vb", "php", "ex", "exs", "erl", "clj", "lua", "dart", "r", "pl", "sh", "bash", "bats"]);
const VENDORED_DIRECTORIES = new Set(["node_modules", "bower_components", "jspm_packages", ".yarn", "vendor", "vendors", "third_party", "third-party", "thirdparty", "3rdparty", "site-packages", ".venv", "venv", ".bundle", "pods", "carthage"]);

// A gap of a logic skip, in the shape of the other `## QA mode` refusals of the triage gate.
function skipGap(what) {
  return `## QA mode (skip with a logic line: ${what})`;
}

// The path relative to the root, or null when it is the root itself or leaves it.
function insideRoot(root, path) {
  const inner = relative(root, path);
  return inner === "" || inner === ".." || inner.startsWith(`..${sep}`) || isAbsolute(inner) ? null : inner;
}

// Whether a path relative to the root has a code extension on the closed list, read in any case.
function isCodeFile(inner) {
  return TEST_CODE_EXTENSIONS.has(extname(inner).slice(1).toLowerCase());
}

// Whether any directory of a path relative to the root is a vendored one, read in any case because a case-insensitive disk opens `VENDOR/` too.
function isVendored(inner) {
  return inner.toLowerCase().split(sep).slice(0, -1).some((directory) => VENDORED_DIRECTORIES.has(directory));
}

// Whether a cited path is, once `..` and links are resolved, a regular code file of the worktree's own tree with a test's shape; any read error answers no.
function isWorktreeTest(root, cited) {
  try {
    const real = realpathSync(resolve(root, cited));
    const inner = insideRoot(root, real);
    return inner !== null && isTestPath(inner) && isCodeFile(inner) && !isVendored(inner) && statSync(real).isFile();
  } catch {
    return false;
  }
}

// The real path of the run's worktree, or null with the reason it cannot be read.
function readableWorktree(run, env) {
  try {
    return { root: realpathSync(worktreeOf(run, env)), reason: null };
  } catch (err) {
    return { root: null, reason: String(err?.message ?? err).split("\n")[0] };
  }
}

// What a logic skip's sentence cites that the worktree does not prove: this is the one disk read of the triage gate, which `run check` feeds to the pure `evaluateCheck` as its gaps.
export function citedTestGaps(run, raw, env) {
  const cited = citedTestPaths(raw);
  if (cited.length === 0) return [];
  const { root, reason } = readableWorktree(run, env);
  if (root === null) return [skipGap(`the worktree cannot be read, so ${cited.join(", ")} is not verified: ${reason}`)];
  const unproven = cited.filter((path) => !isWorktreeTest(root, path));
  return unproven.length === 0 ? [] : [skipGap(`${unproven.join(", ")} is not a test file inside the worktree`)];
}
