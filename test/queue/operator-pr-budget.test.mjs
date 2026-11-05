import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARD_PR_VIEW_TIMEOUT_MS } from "../../src/host/gh.mjs";
import { overridePrBudgetMs, prBudgetMs, prStates } from "../../src/queue/operator-pr-budget.mjs";

const URL = "https://github.com/acme/api/pull/7";

test("the guard's gh budget is 3 s by default, and an override puts it back when restored", () => {
  assert.equal(GUARD_PR_VIEW_TIMEOUT_MS, 3000);
  assert.equal(prBudgetMs(), 3000);
  const restore = overridePrBudgetMs(60000);
  assert.equal(prBudgetMs(), 60000);
  restore();
  assert.equal(prBudgetMs(), 3000);
});

test("an override that is not a finite number of ms above 0 is refused", () => {
  for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "60000"]) assert.throws(() => overridePrBudgetMs(ms), /finite number of ms above 0/);
  assert.equal(prBudgetMs(), 3000);
});

test("under the default budget, pull request checks that are off still answer so", () => {
  const states = prStates([URL], { NIGHTQUEUE_NO_PR_CHECK: "1" });
  assert.deepEqual(states.get(URL), { ok: false, why: "pull request checks are off (NIGHTQUEUE_NO_PR_CHECK=1)" });
});
