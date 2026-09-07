import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt } from "../../src/queue/spawn.mjs";
import {
  extractNotice,
  extractNoticeFromStream,
  extractPrUrl,
  extractResultText,
  extractSessionIdFromEventLine,
  extractSlugFromEventLine,
  extractUsage,
  hasGateMarker,
  hasGateMarkerInStream,
  isSessionIdSafe,
  isSubagentEvent,
  orchestratorText,
  parseSlugLine,
  sumUsage,
  tokensFromEventLine,
} from "../../src/queue/stream.mjs";
import {
  assistantEvent,
  doneStream,
  gateStream,
  GATE_MARKER,
  noticeText,
  PR_URL,
  resultEvent,
  SESSION_ID,
  SLUG,
  slugEvent,
  systemInitEvent,
  toNdjson,
} from "../../test-support/streams.mjs";

// One NDJSON line, the unit every extractor of the stream consumes.
function line(event) {
  return JSON.stringify(event);
}

test("only the ORCHESTRATOR speaks: a subagent event is never read as pipeline output", () => {
  assert.equal(isSubagentEvent({ parent_tool_use_id: "toolu_1" }), true);
  assert.equal(isSubagentEvent({ subagent_type: "coder" }), true);
  assert.equal(isSubagentEvent({ parent_tool_use_id: "", subagent_type: "" }), false);
  assert.equal(orchestratorText(assistantEvent("hello")), "hello");
  assert.equal(orchestratorText(assistantEvent("hello", { parentToolUseId: "toolu_1" })), null);
  assert.equal(orchestratorText(systemInitEvent()), null);
  assert.equal(extractSlugFromEventLine(line(slugEvent("from-subagent", { parentToolUseId: "toolu_1" }))), null);
});

test("the slug is read from a STANDALONE line, never from a mention or from the placeholder", () => {
  assert.equal(parseSlugLine("QUEUE_SLUG: fix-the-worker"), "fix-the-worker");
  assert.equal(parseSlugLine("  QUEUE_SLUG:   fix-the-worker  "), "fix-the-worker");
  assert.equal(parseSlugLine("Print `QUEUE_SLUG: <slug>` alone on a line"), null);
  assert.equal(parseSlugLine("QUEUE_SLUG: <slug>"), null);
  assert.equal(parseSlugLine("QUEUE_SLUG: fix the worker"), null);
  assert.equal(parseSlugLine("QUEUE_SLUG: ../escape"), null);
  assert.equal(extractSlugFromEventLine(line(slugEvent(SLUG))), SLUG);
  assert.equal(extractSlugFromEventLine("not json at all"), null);
  assert.equal(
    extractSlugFromEventLine(line(assistantEvent("QUEUE_SLUG: first-guess\nQUEUE_SLUG: final-slug"))),
    "final-slug",
    "the last standalone line of the event should win",
  );
});

test("a session id only becomes argv of --resume when it is safe, and it comes from any event", () => {
  assert.equal(isSessionIdSafe(SESSION_ID), true);
  assert.equal(isSessionIdSafe("short"), false);
  assert.equal(isSessionIdSafe("--dangerous-flag"), false);
  assert.equal(isSessionIdSafe("session/../../etc"), false);
  assert.equal(isSessionIdSafe("session.with.dots"), false);
  assert.equal(extractSessionIdFromEventLine(line(systemInitEvent())), SESSION_ID);
  assert.equal(extractSessionIdFromEventLine(line(systemInitEvent({ sessionId: "bad/id" }))), null);
  assert.equal(extractSessionIdFromEventLine("{ truncated json"), null);
});

test("the gate marker only counts as a standalone heading outside a code fence", () => {
  assert.equal(hasGateMarker(GATE_MARKER), true);
  assert.equal(hasGateMarker(`text before\n\n###### requires user confirmation\n\nreason`), true);
  assert.equal(hasGateMarker("the report has a `## Requires user confirmation` section"), false);
  assert.equal(hasGateMarker("```md\n## Requires user confirmation\n```"), false);
  assert.equal(hasGateMarker("  12\t## Requires user confirmation"), false);
  assert.equal(hasGateMarker("## Requires user confirmation now"), false);
  assert.equal(hasGateMarker(buildPrompt({ job: { id: 1, prompt: "fix the worker" } })), false, "the prompt of the runner echoed as a gate");
  assert.equal(hasGateMarkerInStream(gateStream()), true);
  assert.equal(hasGateMarkerInStream(doneStream()), false);
  assert.equal(
    hasGateMarkerInStream(toNdjson([assistantEvent(GATE_MARKER, { parentToolUseId: "toolu_1" })])),
    false,
    "a subagent announced the gate",
  );
});

test("a NESTED code fence never flips the reading of the rest of the text", () => {
  const nested = ["````md", "example of a report:", "```sh", "git status", "```", "````", "", GATE_MARKER].join("\n");
  assert.equal(hasGateMarker(nested), true, "the heading after a nested fence was read as if it were inside code");
  const quotedOnly = ["````md", "## Requires user confirmation", "```sh", "git status", "```", "````"].join("\n");
  assert.equal(hasGateMarker(quotedOnly), false, "a heading quoted inside the outer fence opened a gate");
  const notice = ["````md", "## Notice", "quoted", "```", "inner", "```", "````", "", "## Notice", "", "the real one"].join("\n");
  assert.equal(extractNotice(notice), "the real one");
  assert.equal(extractPrUrl(["````md", "```", PR_URL, "```", "````"].join("\n")), null, "a URL nested two fences deep was delivered");
});

test("the notice is the LAST `## Notice` section, and a fenced heading never opens one", () => {
  assert.equal(extractNotice(noticeText("first")), "first");
  assert.equal(extractNotice("## Notice\n\nfirst\n\n## Notice\n\nsecond"), "second");
  assert.equal(extractNotice("```\n## Notice\n\nquoted\n```"), null);
  assert.equal(extractNotice("no heading here"), null);
  assert.equal(extractNoticeFromStream(doneStream({ notice: "the pull request is open" })), "the pull request is open");
  assert.equal(extractNoticeFromStream(toNdjson([resultEvent({ text: noticeText("only in the result") })])), "only in the result");
  assert.equal(extractNoticeFromStream(doneStream({ notice: undefined }).replace(/## Notice/g, "Notice")), null);
});

test("the notice reported is the run's FINAL decision, not a Notice echoed by an earlier assistant message", () => {
  const log = toNdjson([
    systemInitEvent(),
    assistantEvent(
      "For context, here is what the previous phase reported:\n\n## Notice\n\nStale: last night's deploy failed and was rolled back.",
      { messageId: "msg_echo" },
    ),
    assistantEvent("Continuing the work now that the context is clear.", { messageId: "msg_work" }),
    resultEvent({ text: noticeText("Real: the pull request is open and the checks are green.") }),
  ]);

  assert.equal(
    extractNoticeFromStream(log),
    "Real: the pull request is open and the checks are green.",
    "a stale notice echoed mid-stream won over the final one of the result event",
  );
});

test("the final text and the pull request URL come from the result event, last match wins", () => {
  assert.equal(extractResultText(doneStream()), `Done. Pull request: ${PR_URL}`);
  assert.equal(extractResultText(toNdjson([resultEvent({ text: "" })])), "");
  assert.equal(extractResultText(toNdjson([assistantEvent("no result event")])), null);
  assert.equal(extractPrUrl(`old https://github.com/acme/api/pull/1 then ${PR_URL}`), PR_URL);
  assert.equal(extractPrUrl("https://gitlab.com/acme/api/merge_requests/2"), null);
  assert.equal(extractPrUrl(null), null);
});

test("only a line that DELIVERS the pull request counts: a citation, an example or a failure never does", () => {
  assert.equal(extractPrUrl(`Done. Pull request: ${PR_URL}`), PR_URL);
  assert.equal(extractPrUrl(`- ${PR_URL}`), PR_URL);
  assert.equal(extractPrUrl(`Opened the pull request (${PR_URL}).`), PR_URL);
  assert.equal(extractPrUrl(`a similar fix is in ${PR_URL} on another repo, but I opened nothing here`), null);
  assert.equal(extractPrUrl(`Failed to open pull request: ${PR_URL}`), null);
  assert.equal(extractPrUrl(["here is the shape of the link:", "```", PR_URL, "```"].join("\n")), null);
  assert.equal(extractPrUrl(`  12\t${PR_URL}`), null, "a quoted file line was read as a delivery");
});

test("usage adds up per message id and the result event of the session has the final word", () => {
  const twice = assistantEvent("same message", { messageId: "msg_dup", usage: { tokensIn: 7, tokensOut: 3 } });
  const estimated = extractUsage(toNdjson([twice, twice, assistantEvent("no usage")]));
  assert.deepEqual(estimated, { tokensIn: 7, tokensOut: 3, cacheRead: 0, cacheCreation: 0, costUsd: null, sessions: 1, estimated: true });

  const reported = extractUsage(doneStream({ usage: { tokensIn: 1000, tokensOut: 200, cacheRead: 50, cacheCreation: 25, costUsd: 0.12 } }));
  assert.deepEqual(reported, { tokensIn: 1000, tokensOut: 200, cacheRead: 50, cacheCreation: 25, costUsd: 0.12, sessions: 1, estimated: false });

  assert.equal(extractUsage(""), null);
  assert.deepEqual(tokensFromEventLine(line(systemInitEvent())), { id: null, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 0 });
});

test("the usage of several attempts is one total, and a missing attempt never poisons it", () => {
  const first = { tokensIn: 10, tokensOut: 2, cacheRead: 1, cacheCreation: 0, costUsd: 0.5, sessions: 1, estimated: false };
  const second = { tokensIn: 5, tokensOut: 1, cacheRead: 0, cacheCreation: 3, costUsd: null, sessions: 1, estimated: true };
  assert.deepEqual(sumUsage([first, null, second]), {
    tokensIn: 15,
    tokensOut: 3,
    cacheRead: 1,
    cacheCreation: 3,
    costUsd: 0.5,
    sessions: 2,
    estimated: true,
  });
  assert.equal(sumUsage([null, null]), null);
  assert.equal(sumUsage(null), null);
});
