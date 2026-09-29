import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyJobResult } from "../../src/queue/classify.mjs";
import { codeChangePublishedEvent, PR_URL, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

// H3 (group B): the job's own real PR event comes first; a stray `code_change_published` event
// for a DIFFERENT repository arrives LAST in the same attempt's log (a real, non-injected route:
// the agent's own Bash session runs `gh pr create -R other-org/other-repo …` for an unrelated
// reason after already opening the run's real PR). `extractPublishedPrUrl` reads neither `repo`
// nor `action`, so the runtime must not let the later, foreign event overwrite the delivery of
// THIS run's own repository.
test("a code_change_published event for another repository, arriving last, never overrides this run's own PR", () => {
  const foreignUrl = "https://github.com/other-org/other-repo/pull/999";
  const log = toNdjson([
    systemInitEvent(),
    codeChangePublishedEvent(), // the run's own, correct delivery: acme/api#42, action "created"
    resultEvent({ text: `Done. Pull request: ${PR_URL}` }),
    codeChangePublishedEvent({ url: foreignUrl, repo: "other-org/other-repo", identifier: "999" }),
  ]);

  const outcome = classifyJobResult({ log, exitCode: 0 });

  assert.equal(outcome.prUrl, PR_URL, "a code_change_published event for a repo this run does not own must never become the run's delivered PR");
  assert.equal(outcome.status, "done");
});

// Same shape, but the stray event is a DIFFERENT pull request of the run's OWN repo, reported with
// a non-"created" action (e.g. the agent's own `gh pr close`/`gh pr edit` on an unrelated PR of the
// same repo, run directly through Bash outside the pipeline's own `run pr` step). A different URL
// under a non-created action must not be read as this run's delivery — only "created" ever is.
// The URL is deliberately DIFFERENT from PR_URL so the assertion cannot pass merely because the
// stray event happens to repeat the same URL (which would prove nothing about `action` being read).
test("a code_change_published event for a different PR with a non-created action, arriving last, never overrides the original delivery", () => {
  const staleUrl = "https://github.com/acme/api/pull/43";
  const log = toNdjson([
    systemInitEvent(),
    codeChangePublishedEvent(), // action: "created" — the real delivery, acme/api#42
    resultEvent({ text: `Done. Pull request: ${PR_URL}` }),
    codeChangePublishedEvent({ url: staleUrl, identifier: "43", action: "closed" }),
  ]);

  const outcome = classifyJobResult({ log, exitCode: 0 });

  assert.equal(outcome.prUrl, PR_URL, "a non-created action on a different PR must not be read as a competing delivery");
  assert.equal(outcome.status, "done");
});
