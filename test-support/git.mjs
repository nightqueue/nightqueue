import { execFileSync } from "node:child_process";

const NAME = "nightqueue";
const EMAIL = "nightqueue@example.invalid";

// Environment of a commit that depends on nothing of the machine: the identity always wins over the one of the host.
function commitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: NAME,
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_COMMITTER_NAME: NAME,
    GIT_COMMITTER_EMAIL: EMAIL,
  };
}

// Creates a real git repository with one empty commit, never reading the identity or the signing config of the machine.
export function initGitRepo(path) {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", path]);
  execFileSync("git", ["-C", path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"], { env: commitEnv() });
  return path;
}
