import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getIssue, saveIssue } from "../../src/memory/issues.mjs";
import { makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

// A home with a registered project and one roadmap item to queue from.
function makeIssuesHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const item = saveIssue({ type: "improvement", projectId: projectIdOf(env, "alpha"), title: "rewrite runner heartbeat", detail: "survive a slow disk" }, env);
  return { env, item };
}

// H2: `--roadmap <id> --tier --run` — the roadmap variant. `--roadmap` binds its id first, then the same
// ambiguous-option refusal for `--tier` fires before `queueIssue` ever calls `addJob`, so the item is
// never touched: no partial state, and the operator is told `--tier` (not the roadmap id) is the problem.
test("`queue add --roadmap <id> --tier --run` refuses cleanly and leaves the roadmap item untouched", (t) => {
  const { env, item } = makeIssuesHome(t, "roadmap-tier-swallow-h2");
  const elsewhere = makeDir(t, "roadmap-tier-swallow-h2-cwd");

  const result = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id), "--tier", "--run"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });

  assert.equal(result.status, 1, `expected a refusal, got: ${result.stdout}`);
  assert.match(result.stderr, /nightqueue: Option '--tier' argument is ambiguous\./);
  assert.match(result.stderr, /Did you forget to specify the option argument for '--tier'\?/);

  const row = getIssue(item.id, env);
  assert.equal(row.status, "todo", "the roadmap item changed status even though the tier was refused");
  assert.equal(row.job_id, null, "the roadmap item got a job_id even though the tier was refused");
});
