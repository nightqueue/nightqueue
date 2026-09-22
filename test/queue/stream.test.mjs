import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyJobResult } from "../../src/queue/classify.mjs";
import { orchestratorRoots } from "../../src/queue/orchestrator-scope.mjs";
import { buildPrompt } from "../../src/queue/spawn.mjs";
import {
  extractBaselineCtx,
  extractNotice,
  extractNoticeFromStream,
  extractPrUrl,
  extractPrUrlFromStream,
  extractPublishedPrUrl,
  extractHostCommandCounts,
  extractOrchestratorCounts,
  extractOrchestratorSessionIds,
  extractResultText,
  extractSessionIdFromEventLine,
  extractSlugFromEventLine,
  extractSlugTypeFromEventLine,
  extractTierRaiseFromEventLine,
  extractUsage,
  hasGateMarker,
  hasGateMarkerInStream,
  isSessionIdSafe,
  isSubagentEvent,
  lastAttemptStream,
  orchestratorText,
  parseSlugLine,
  parseSlugTypeLine,
  parseTierRaiseLine,
  publishedDelivery,
  runtimeKillFromStream,
  sawDisabledBackgroundTask,
  sumHostCommandCounts,
  sumOrchestratorCounts,
  sumUsage,
  tokensFromEventLine,
} from "../../src/queue/stream.mjs";
import {
  assistantEvent,
  attemptMarker,
  codeChangePublishedEvent,
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
  toolResultEvent,
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

test("the run is renamed by a STANDALONE `SLUG:` line, with its optional type, and the FIRST declaration of the event wins", () => {
  assert.deepEqual(parseSlugTypeLine("SLUG: fix-the-worker TYPE: bug/error"), { slug: "fix-the-worker", type: "bug/error" });
  assert.deepEqual(parseSlugTypeLine("  SLUG:   fix-the-worker  "), { slug: "fix-the-worker", type: null });
  assert.equal(parseSlugTypeLine("QUEUE_SLUG: fix-the-worker"), null, "the older protocol was read as a rename");
  assert.equal(parseSlugTypeLine("print `SLUG: <slug> TYPE: <type>` alone on a line"), null);
  assert.equal(parseSlugTypeLine("SLUG: <slug> TYPE: <type>"), null);
  assert.equal(parseSlugTypeLine("SLUG: ../escape TYPE: bug/error"), null);
  assert.equal(parseSlugTypeLine("SLUG: fix the worker"), null);
  assert.deepEqual(
    extractSlugTypeFromEventLine(line(assistantEvent("SLUG: first-name TYPE: feature/refactor\nSLUG: second-name"))),
    { slug: "first-name", type: "feature/refactor" },
    "the first standalone line of the event should win: a run is renamed once",
  );
  assert.equal(extractSlugTypeFromEventLine(line(assistantEvent("SLUG: from-subagent", { parentToolUseId: "toolu_1" }))), null);
  assert.equal(extractSlugTypeFromEventLine(line(slugEvent(SLUG))), null);
  assert.equal(extractSlugTypeFromEventLine("not json at all"), null);
});

test("a tier raise is read from the STANDALONE line of the Brief, and only from the orchestrator", () => {
  assert.deepEqual(parseTierRaiseLine("Tier raised: simple -> complex: a native SDK is involved"), {
    from: "simple",
    to: "complex",
    reason: "a native SDK is involved",
  });
  assert.deepEqual(parseTierRaiseLine("   Tier raised:  trivial  ->  simple :  the brief is ambiguous  "), {
    from: "trivial",
    to: "simple",
    reason: "the brief is ambiguous",
  });
  assert.equal(parseTierRaiseLine("A raise is written as `Tier raised: <from> -> <to>: <evidence>`"), null);
  assert.equal(parseTierRaiseLine("Tier raised: simple -> complex"), null);
  assert.equal(parseTierRaiseLine("Tier raised: simple -> urgent: a stack trace"), null);
  assert.equal(parseTierRaiseLine(null), null);

  const brief = assistantEvent("## Brief\nTier: simple\nTier raised: simple -> complex: a stack trace\nType: bug/error");
  assert.deepEqual(extractTierRaiseFromEventLine(line(brief)), { from: "simple", to: "complex", reason: "a stack trace" });
  assert.equal(extractTierRaiseFromEventLine(line(assistantEvent("Tier raised: simple -> complex: x", { parentToolUseId: "toolu_1" }))), null);
  assert.equal(extractTierRaiseFromEventLine("not json at all"), null);
  assert.deepEqual(
    extractTierRaiseFromEventLine(line(assistantEvent("Tier raised: trivial -> simple: a guess\nTier raised: simple -> complex: the evidence"))),
    { from: "simple", to: "complex", reason: "the evidence" },
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

test("the gate block the skill prescribes opens a gate and carries the way to answer it", () => {
  const block = [
    "## Notice",
    "",
    GATE_MARKER,
    "",
    "Renaming the column drops the old one; keeping both costs a migration. I need a decision.",
    "",
    'Answer with: nightshift queue retry 7 --note "<your answer>"',
  ].join("\n");
  const log = toNdjson([systemInitEvent(), resultEvent({ text: block })]);

  assert.equal(hasGateMarker(block), true, "the block did not keep the job at the gate");
  const notice = extractNoticeFromStream(log);
  assert.equal(hasGateMarker(notice), true, "the `## Notice` body must itself carry the confirmation heading");
  assert.ok(notice.includes("nightshift queue retry"), notice);
  assert.equal(notice.endsWith('--note "<your answer>"'), true, notice);
  assert.equal(classifyJobResult({ log, exitCode: 0 }).status, "gate");
  assert.equal(classifyJobResult({ log, exitCode: 0 }).noticeMd, notice);
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

test("the pull request of the stream is the ORCHESTRATOR's: a subagent never delivers one", () => {
  const delivered = toNdjson([assistantEvent(`Done. Pull request: ${PR_URL}`, { messageId: "msg_pr" }), resultEvent({ text: "Telemetry recorded." })]);
  assert.equal(extractPrUrlFromStream(delivered), PR_URL, "the orchestrator's own intermediate delivery was ignored");
  assert.equal(
    extractPrUrlFromStream(toNdjson([assistantEvent(`Done. Pull request: ${PR_URL}`, { parentToolUseId: "toolu_1" })])),
    null,
    "a subagent delivered the pull request",
  );
});

test("the pull request the HOST published is read from its own event, and only the run's own repository speaks", () => {
  const other = "https://github.com/other-org/other-repo/pull/7";
  const foreign = codeChangePublishedEvent({ url: other, repo: "other-org/other-repo", identifier: "7" });
  const reopened = codeChangePublishedEvent({ url: "https://github.com/acme/api/pull/44", identifier: "44" });
  assert.equal(extractPublishedPrUrl(toNdjson([systemInitEvent(), codeChangePublishedEvent(), resultEvent({ text: "Telemetry recorded." })])), PR_URL);
  assert.equal(
    extractPublishedPrUrl(toNdjson([foreign, codeChangePublishedEvent()]), { repo: "acme/api" }),
    PR_URL,
    "a pull request opened earlier for another repository spoke for this run",
  );
  assert.equal(
    extractPublishedPrUrl(toNdjson([codeChangePublishedEvent(), foreign])),
    PR_URL,
    "a pull request opened later for another repository spoke for this run",
  );
  assert.equal(
    extractPublishedPrUrl(toNdjson([codeChangePublishedEvent(), reopened])),
    reopened.url,
    "two pull requests of the run's OWN repository: the last published one is the delivery",
  );
  assert.equal(
    extractPublishedPrUrl(toNdjson([codeChangePublishedEvent(), { ...reopened, action: "closed" }])),
    PR_URL,
    "an event that is not the opening of a pull request was read as a delivery",
  );
  assert.equal(
    extractPublishedPrUrl(toNdjson([foreign]), { repo: "acme/api" }),
    other,
    "a repository the caller vouches for but nothing published silenced what the host really published",
  );
  assert.equal(
    extractPublishedPrUrl(toNdjson([codeChangePublishedEvent(), codeChangePublishedEvent({ url: "https://github.com/acme/api/issues/9" })])),
    PR_URL,
    "a published url that is not a pull request was believed",
  );
  assert.equal(extractPublishedPrUrl(toNdjson([codeChangePublishedEvent({ url: 42 })])), null);
  assert.equal(extractPublishedPrUrl(doneStream()), null, "a stream with no published event invented one");
  assert.equal(extractPublishedPrUrl(toNdjson([{ ...codeChangePublishedEvent(), type: "assistant" }])), null, "another type of event published a pull request");
  assert.equal(extractPublishedPrUrl(null), null);
});

test("the host's publication is the run's delivery only on the run's own branch; the runtime record beats one that cannot prove it", () => {
  const recorded = "https://github.com/acme/api/pull/40";
  const ownUrl = "https://github.com/acme/api/pull/43";
  const foreignUrl = "https://github.com/acme/api/pull/44";
  const own = codeChangePublishedEvent({ url: ownUrl, identifier: "43", branch: "feat/x" });
  const foreign = codeChangePublishedEvent({ url: foreignUrl, identifier: "44", branch: "scratch/qa" });
  const unproven = codeChangePublishedEvent();
  const otherRepo = codeChangePublishedEvent({ url: "https://github.com/other-org/other-repo/pull/7", repo: "other-org/other-repo", identifier: "7", branch: "worktree-feat+x" });
  const run = { repo: "acme/api", branch: "worktree-feat+x" };
  const cases = [
    { name: "own, with record", events: [own], opts: { ...run, recorded }, url: ownUrl, stray: null },
    { name: "own, no record", events: [own], opts: run, url: ownUrl, stray: null },
    { name: "own after foreign", events: [foreign, own], opts: { ...run, recorded }, url: ownUrl, stray: { url: foreignUrl, branch: "scratch/qa" } },
    { name: "foreign, with record", events: [foreign], opts: { ...run, recorded }, url: null, stray: { url: foreignUrl, branch: "scratch/qa" } },
    { name: "foreign, no record", events: [foreign], opts: run, url: null, stray: { url: foreignUrl, branch: "scratch/qa" } },
    { name: "unproven, with record", events: [unproven], opts: { ...run, recorded }, url: null, stray: { url: PR_URL, branch: null } },
    { name: "unproven equal to the record", events: [unproven], opts: { ...run, recorded: PR_URL }, url: null, stray: null },
    { name: "unproven, no record", events: [unproven], opts: run, url: PR_URL, stray: null },
    { name: "unproven wins, foreign flagged", events: [unproven, foreign], opts: run, url: PR_URL, stray: { url: foreignUrl, branch: "scratch/qa" } },
    { name: "branch named, run has none, with record", events: [foreign], opts: { repo: "acme/api", recorded }, url: null, stray: { url: foreignUrl, branch: "scratch/qa" } },
    { name: "another repository never speaks", events: [otherRepo, unproven], opts: { ...run, recorded: PR_URL }, url: null, stray: null },
    { name: "nothing published", events: [], opts: { ...run, recorded }, url: null, stray: null },
  ];
  for (const { name, events, opts, url, stray } of cases) {
    assert.deepEqual(publishedDelivery(toNdjson(events), opts), { url, stray }, name);
  }
});

test("only a marker the runtime itself wrote, in sequence and unquoted, closes an attempt of an accumulated log", () => {
  const first = toNdjson([resultEvent({ text: `Done. Pull request: ${PR_URL}` })]);
  const second = toNdjson([resultEvent({ text: "Stopped at the gate." })]);

  assert.equal(lastAttemptStream(first), first, "a log with no marker at all stopped being one whole attempt");
  assert.equal(lastAttemptStream(`${attemptMarker(1)}\n${first}`), first);
  assert.equal(lastAttemptStream(`${attemptMarker(1)}\n${first}${attemptMarker(2)}\n${second}`), second, "an older attempt spoke for the outcome");

  const decoy = `${first}${attemptMarker(2)}\n`;
  assert.equal(lastAttemptStream(decoy), decoy, "a marker out of the runtime's own numbering was trusted as a boundary");

  const fenced = [attemptMarker(1), "```", attemptMarker(2), "```", ""].join("\n");
  assert.equal(lastAttemptStream(fenced), ["```", attemptMarker(2), "```", ""].join("\n"), "a marker quoted inside a code fence closed an attempt");

  const quoted = [attemptMarker(1), `  12\t${attemptMarker(2)}`, ""].join("\n");
  assert.equal(lastAttemptStream(quoted), [`  12\t${attemptMarker(2)}`, ""].join("\n"), "a marker inside a `cat -n` quotation closed an attempt");
});

// The raw (non-JSON) line the CLI prints when it gives up waiting for a background task.
const CEILING_LINE = "Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.";

test("a runtime kill is read from the raw ceiling line plus the `task_updated` killed event, named from the last `background_tasks_changed` that lists it", () => {
  const backgroundTasksChanged = { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task_1", task_type: "local_agent", description: "Verify checks and QA PoCs" }] };
  const killed = { type: "system", subtype: "task_updated", task_id: "task_1", patch: { status: "killed" } };
  const log = [line(systemInitEvent()), line(backgroundTasksChanged), CEILING_LINE, line(killed)].join("\n");

  assert.deepEqual(runtimeKillFromStream(log), {
    taskId: "task_1",
    description: "Verify checks and QA PoCs",
    taskType: "local_agent",
    ceilingSeen: true,
    noticeAfterKill: false,
    runInBackground: false,
    autoBackgrounded: false,
  });
});

test("a killed task with no `background_tasks_changed` listing it falls back to its own task_id as the description, with no task type", () => {
  const killed = { type: "system", subtype: "task_updated", task_id: "task_9", patch: { status: "killed" } };
  const log = toNdjson([systemInitEvent(), killed]);

  assert.deepEqual(runtimeKillFromStream(log), {
    taskId: "task_9",
    description: "task_9",
    taskType: null,
    ceilingSeen: false,
    noticeAfterKill: false,
    runInBackground: false,
    autoBackgrounded: false,
  });
});

test("a kill detected only by the raw ceiling line, with no `task_updated` at all, falls back to the last background task listed", () => {
  const backgroundTasksChanged = { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task_2", description: "Run the migration" }] };
  const log = [line(systemInitEvent()), line(backgroundTasksChanged), CEILING_LINE].join("\n");

  assert.deepEqual(runtimeKillFromStream(log), {
    taskId: "task_2",
    description: "Run the migration",
    taskType: null,
    ceilingSeen: true,
    noticeAfterKill: false,
    runInBackground: false,
    autoBackgrounded: false,
  });
});

test("a task's type is read from `task_started` when `background_tasks_changed` never carried one", () => {
  const started = { type: "system", subtype: "task_started", task_id: "task_3", task_type: "local_bash" };
  const backgroundTasksChanged = { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task_3", description: "find /" }] };
  const killed = { type: "system", subtype: "task_updated", task_id: "task_3", patch: { status: "killed" } };
  const log = [line(systemInitEvent()), line(started), line(backgroundTasksChanged), CEILING_LINE, line(killed)].join("\n");

  assert.deepEqual(runtimeKillFromStream(log), {
    taskId: "task_3",
    description: "find /",
    taskType: "local_bash",
    ceilingSeen: true,
    noticeAfterKill: false,
    runInBackground: false,
    autoBackgrounded: false,
  });
});

test("a clean stream with neither the ceiling line nor a killed task is never a runtime kill", () => {
  assert.equal(runtimeKillFromStream(doneStream()), null);
  assert.equal(runtimeKillFromStream(""), null);
});

test("a forged mention of the ceiling line never counts as a kill: quoted inside an assistant message or inside a fenced block", () => {
  const quoted = toNdjson([systemInitEvent(), assistantEvent(`The CLI printed:\n${CEILING_LINE}`)]);
  assert.equal(runtimeKillFromStream(quoted), null, "the line quoted inside a JSON event was read as a raw kill line");

  const fenced = [line(systemInitEvent()), "```", CEILING_LINE, "```"].join("\n");
  assert.equal(runtimeKillFromStream(fenced), null, "a fenced quotation of the ceiling line was read as a real kill");
});

// A `task_updated` event patching `is_backgrounded`, in the shape the host writes it.
function backgroundedEvent(taskId, isBackgrounded) {
  return { type: "system", subtype: "task_updated", task_id: taskId, patch: { is_backgrounded: isBackgrounded } };
}

test("sawDisabledBackgroundTask is true only when a task_updated patch carries is_backgrounded: true", () => {
  assert.equal(sawDisabledBackgroundTask(toNdjson([systemInitEvent(), backgroundedEvent("task_1", true)])), true);
  assert.equal(sawDisabledBackgroundTask(toNdjson([systemInitEvent(), backgroundedEvent("task_1", false)])), false, "a subagent that still ran foreground counted as backgrounded");
});

test("sawDisabledBackgroundTask is false on a clean stream and an empty log", () => {
  assert.equal(sawDisabledBackgroundTask(doneStream()), false);
  assert.equal(sawDisabledBackgroundTask(""), false);
});

test("sawDisabledBackgroundTask only reads the LAST attempt of the log", () => {
  const earlierAttempt = `${attemptMarker(1)}\n${toNdjson([systemInitEvent(), backgroundedEvent("task_1", true)])}`;
  const lastAttemptClean = `${attemptMarker(2)}\n${toNdjson([systemInitEvent()])}`;
  assert.equal(sawDisabledBackgroundTask(`${earlierAttempt}${lastAttemptClean}`), false, "an earlier attempt's backgrounded task leaked into the last one");
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

test("the aggregate usage block of the result event counts, in the snake_case shape the CLI emits", () => {
  const stream = toNdjson([
    systemInitEvent(),
    resultEvent({ text: "done", tokensIn: 900, tokensOut: 120, cacheRead: 40, cacheCreation: 15, costUsd: 0.3, usageShape: "aggregate" }),
  ]);
  assert.deepEqual(extractUsage(stream), {
    tokensIn: 900,
    tokensOut: 120,
    cacheRead: 40,
    cacheCreation: 15,
    costUsd: 0.3,
    sessions: 1,
    estimated: false,
  });
});

test("a result event carrying both usage shapes counts the tokens once, never twice", () => {
  const tokens = { tokensIn: 900, tokensOut: 120, cacheRead: 40, cacheCreation: 15, costUsd: 0.3 };
  const both = extractUsage(toNdjson([systemInitEvent(), resultEvent({ text: "done", ...tokens, usageShape: "both" })]));
  const models = extractUsage(toNdjson([systemInitEvent(), resultEvent({ text: "done", ...tokens, usageShape: "models" })]));
  assert.deepEqual(both, models);
  assert.deepEqual(both, { tokensIn: 900, tokensOut: 120, cacheRead: 40, cacheCreation: 15, costUsd: 0.3, sessions: 1, estimated: false });
});

test("when the result event reports tokens, it wins over the assistants of the same session", () => {
  const stream = toNdjson([
    systemInitEvent(),
    assistantEvent("working", { messageId: "msg_work", usage: { tokensIn: 7, tokensOut: 3 } }),
    resultEvent({ text: "done", tokensIn: 900, tokensOut: 120, cacheRead: 40, cacheCreation: 15, costUsd: 0.3, usageShape: "aggregate" }),
  ]);
  assert.deepEqual(extractUsage(stream), {
    tokensIn: 900,
    tokensOut: 120,
    cacheRead: 40,
    cacheCreation: 15,
    costUsd: 0.3,
    sessions: 1,
    estimated: false,
  });
});

test("a result event with no usage block at all falls back to the assistants and says the total is estimated", () => {
  const stream = toNdjson([
    systemInitEvent(),
    assistantEvent("working", { messageId: "msg_work", usage: { tokensIn: 7, tokensOut: 3, cacheRead: 1, cacheCreation: 2 } }),
    resultEvent({ text: "done", costUsd: 0.3, usageShape: "none" }),
  ]);
  assert.deepEqual(extractUsage(stream), {
    tokensIn: 7,
    tokensOut: 3,
    cacheRead: 1,
    cacheCreation: 2,
    costUsd: 0.3,
    sessions: 1,
    estimated: true,
  });
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

test("bash_timeouts counts one per matching tool_result block, whether its content is a string or an array of text blocks", () => {
  const stringTimeout = toolResultEvent({ toolUseId: "toolu_1", content: "Exit code 143\nCommand timed out after 5s", isError: true });
  const arrayTimeout = toolResultEvent({
    toolUseId: "toolu_2",
    content: [{ type: "text", text: "Exit code 143\nCommand timed out after 30s" }],
    isError: true,
  });
  const notAnError = toolResultEvent({ toolUseId: "toolu_3", content: "Command timed out after 5s", isError: false });
  const notATimeout = toolResultEvent({ toolUseId: "toolu_4", content: "ok", isError: true });
  const log = toNdjson([systemInitEvent(), stringTimeout, arrayTimeout, notAnError, notATimeout]);
  assert.deepEqual(extractHostCommandCounts(log), { bashTimeouts: 2, tasksBackgrounded: 0, tasksKilled: 0 });
});

test("tasks_backgrounded counts distinct task ids, never a task_updated with is_backgrounded: false", () => {
  const log = toNdjson([
    systemInitEvent(),
    backgroundedEvent("task_1", true),
    backgroundedEvent("task_1", true),
    backgroundedEvent("task_2", true),
    backgroundedEvent("task_3", false),
  ]);
  assert.deepEqual(extractHostCommandCounts(log), { bashTimeouts: 0, tasksBackgrounded: 2, tasksKilled: 0 });
});

test("tasks_killed counts distinct task ids of a task_updated patch carrying status: killed", () => {
  const killedEvent = (taskId) => ({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "killed" } });
  const log = toNdjson([systemInitEvent(), killedEvent("task_1"), killedEvent("task_1"), killedEvent("task_2")]);
  assert.deepEqual(extractHostCommandCounts(log), { bashTimeouts: 0, tasksBackgrounded: 0, tasksKilled: 2 });
});

test("a host-command event quoted inside a code fence is never read as one", () => {
  const timeout = toolResultEvent({ content: "Exit code 143\nCommand timed out after 5s", isError: true });
  const fenced = [line(systemInitEvent()), "```", line(timeout), line(backgroundedEvent("task_1", true)), "```"].join("\n");
  assert.deepEqual(extractHostCommandCounts(fenced), { bashTimeouts: 0, tasksBackgrounded: 0, tasksKilled: 0 });
  assert.equal(extractHostCommandCounts("").bashTimeouts, 0);
});

test("host command counts sum across attempts, the same way the usage does", () => {
  const first = { bashTimeouts: 1, tasksBackgrounded: 1, tasksKilled: 0 };
  const second = { bashTimeouts: 2, tasksBackgrounded: 0, tasksKilled: 1 };
  assert.deepEqual(sumHostCommandCounts([first, null, second]), { bashTimeouts: 3, tasksBackgrounded: 1, tasksKilled: 1 });
  assert.deepEqual(sumHostCommandCounts([]), { bashTimeouts: 0, tasksBackgrounded: 0, tasksKilled: 0 });
  assert.deepEqual(sumHostCommandCounts(null), { bashTimeouts: 0, tasksBackgrounded: 0, tasksKilled: 0 });
});

const ORCH_RUNS = "/ns-orchestrator-test-home/runs";
const ORCH_WORKTREE = "/ns-orchestrator-test-repo/.claude/worktrees/feat+x";
const ORCH_SESSION = "e8137e49-9348-4b40-a4dc-dfc52cc663fa";

// An assistant event shaped like the CLI's stream-json: the orchestrator's has a null parent, a subagent's names its Agent call.
function orchAssistant({ id, tools = [], usage = null, parent = null, subagentType = null }) {
  const message = {
    model: "claude-opus-5",
    id,
    type: "message",
    role: "assistant",
    content: tools.map(([toolId, name, input]) => ({ type: "tool_use", id: toolId, name, input })),
  };
  if (usage) message.usage = usage;
  const event = { type: "assistant", message, parent_tool_use_id: parent, session_id: ORCH_SESSION };
  if (subagentType) event.subagent_type = subagentType;
  return event;
}

// The stream of one orchestrator attempt that exercises every counter and every exclusion.
function orchestratorStream() {
  const usage = (input, read, created) => ({ input_tokens: input, output_tokens: 50, cache_read_input_tokens: read, cache_creation_input_tokens: created });
  return [
    line(systemInitEvent()),
    line(orchAssistant({ id: "msg_1", tools: [["toolu_a", "Read", { file_path: `${ORCH_RUNS}/nightshift/s/01-triage.md` }]], usage: usage(10, 1000, 100) })),
    line(orchAssistant({ id: "msg_1", tools: [["toolu_a", "Read", { file_path: `${ORCH_RUNS}/nightshift/s/01-triage.md` }]], usage: usage(10, 1000, 100) })),
    line(orchAssistant({ id: "msg_2", tools: [["toolu_b", "Read", { file_path: `${ORCH_WORKTREE}/src/a.mjs` }]] })),
    line(orchAssistant({ id: "msg_3", tools: [["toolu_c", "Grep", { pattern: "foo" }]] })),
    line(orchAssistant({ id: "msg_4", tools: [["toolu_d", "Bash", { command: "git status --short" }], ["toolu_e", "Bash", { command: "git log --oneline" }]] })),
    line(
      orchAssistant({
        id: "msg_5",
        tools: [["toolu_f", "Read", { file_path: `${ORCH_WORKTREE}/src/b.mjs` }], ["toolu_g", "Bash", { command: "grep -rn x src" }]],
        parent: "toolu_agent",
        subagentType: "nightshift:coder",
      }),
    ),
    "```",
    line(orchAssistant({ id: "msg_fenced", tools: [["toolu_h", "Bash", { command: "cat x" }]] })),
    "```",
    line(orchAssistant({ id: "msg_6", usage: usage(5, 2000, 300) })),
  ].join("\n");
}

test("the orchestrator counts: turns by message id, reads outside the roots, Bash and exploration Bash, and the last turn's context", () => {
  const counts = extractOrchestratorCounts(orchestratorStream(), { roots: [ORCH_RUNS], cwd: ORCH_WORKTREE });
  assert.deepEqual(counts, { turns: 5, reads: 2, bash: 2, bashExplore: 1, ctxLast: 2305 });
});

test("the orchestrator counts are zero on an empty stream, and a stream with no usage has no context", () => {
  assert.deepEqual(extractOrchestratorCounts(""), { turns: 0, reads: 0, bash: 0, bashExplore: 0, ctxLast: null });
  const noUsage = toNdjson([orchAssistant({ id: "msg_1", tools: [["toolu_a", "Glob", { pattern: "**/*.mjs" }]] })]);
  assert.deepEqual(extractOrchestratorCounts(noUsage, { roots: [ORCH_RUNS], cwd: ORCH_WORKTREE }), {
    turns: 1,
    reads: 1,
    bash: 0,
    bashExplore: 0,
    ctxLast: null,
  });
});

test("an orchestrator Read of its own session's spilled tool result is never counted, another session's always is", () => {
  const env = { NIGHTSHIFT_JOB_HOME: "/ns-orchestrator-test-home", HOME: "/ns-orchestrator-test-user", CLAUDE_CONFIG_DIR: "/ns-orchestrator-test-claude" };
  const project = "/ns-orchestrator-test-claude/projects/-ns-orchestrator-test-repo";
  const log = toNdjson([
    orchAssistant({ id: "msg_1", tools: [["toolu_a", "Read", { file_path: `${project}/${ORCH_SESSION}/tool-results/toolu_big.txt` }]] }),
    orchAssistant({ id: "msg_2", tools: [["toolu_b", "Read", { file_path: `${project}/other-session/tool-results/toolu_big.txt` }]] }),
    orchAssistant({ id: "msg_3", tools: [["toolu_c", "Read", { file_path: "/ns-orchestrator-test-claude/settings.json" }]] }),
  ]);
  const own = [{ transcriptPath: `${project}/${ORCH_SESSION}.jsonl`, sessionId: ORCH_SESSION }];
  assert.equal(extractOrchestratorCounts(log, { roots: orchestratorRoots(env, own), cwd: ORCH_WORKTREE }).reads, 2);
  assert.equal(extractOrchestratorCounts(log, { roots: orchestratorRoots(env), cwd: ORCH_WORKTREE }).reads, 3);
});

test("the orchestrator's own session ids come from its assistant events only, fenced lines ignored", () => {
  const subagent = { ...orchAssistant({ id: "msg_s", parent: "toolu_agent" }), session_id: "subagent-session" };
  const fenced = { ...orchAssistant({ id: "msg_f" }), session_id: "fenced-session" };
  const unsafe = { ...orchAssistant({ id: "msg_u" }), session_id: "../escape" };
  const log = [toNdjson([orchAssistant({ id: "msg_1" }), subagent, unsafe, orchAssistant({ id: "msg_2" })]), "```", line(fenced), "```"].join("\n");
  assert.deepEqual(extractOrchestratorSessionIds(log), [ORCH_SESSION]);
  assert.deepEqual(extractOrchestratorSessionIds(""), []);
});

test("the orchestrator counts sum across attempts, the context of the last attempt that reported one winning", () => {
  const first = { turns: 10, reads: 1, bash: 4, bashExplore: 2, ctxLast: 150000 };
  const second = { turns: 5, reads: 0, bash: 1, bashExplore: 0, ctxLast: null };
  const third = { turns: 3, reads: 0, bash: 2, bashExplore: 1, ctxLast: 90000 };
  assert.deepEqual(sumOrchestratorCounts([first, null, second]), { turns: 15, reads: 1, bash: 5, bashExplore: 2, ctxLast: 150000 });
  assert.deepEqual(sumOrchestratorCounts([first, second, third]), { turns: 18, reads: 1, bash: 7, bashExplore: 3, ctxLast: 90000 });
  assert.deepEqual(sumOrchestratorCounts([]), { turns: 0, reads: 0, bash: 0, bashExplore: 0, ctxLast: null });
  assert.deepEqual(sumOrchestratorCounts(null), { turns: 0, reads: 0, bash: 0, bashExplore: 0, ctxLast: null });
});

// An `assistant` event with an explicit `parent_tool_use_id`, the same shape the real CLI writes: `null` for the orchestrator's own turn, a tool_use id for a subagent's.
function turnEvent({ parentToolUseId, usage = null }) {
  return {
    type: "assistant",
    session_id: SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    message: { id: `msg_${Math.random().toString(36).slice(2, 10)}`, role: "assistant", content: [{ type: "text", text: "working" }], ...(usage ? { usage } : {}) },
  };
}

test("extractBaselineCtx reads the FIRST orchestrator turn's own usage, ignoring a subagent's even when it comes first", () => {
  const log = toNdjson([
    systemInitEvent(),
    turnEvent({ parentToolUseId: "toolu_sub", usage: { input_tokens: 999, cache_read_input_tokens: 999, cache_creation_input_tokens: 999 } }),
    turnEvent({ parentToolUseId: null, usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 5 } }),
    turnEvent({ parentToolUseId: null, usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
  ]);
  assert.equal(extractBaselineCtx(log), 145);
});

test("extractBaselineCtx treats a missing token field as zero and returns null without an orchestrator usage event", () => {
  const partial = toNdjson([systemInitEvent(), turnEvent({ parentToolUseId: null, usage: { input_tokens: 10 } })]);
  assert.equal(extractBaselineCtx(partial), 10);

  const subagentOnly = toNdjson([systemInitEvent(), turnEvent({ parentToolUseId: "toolu_sub", usage: { input_tokens: 10 } })]);
  assert.equal(extractBaselineCtx(subagentOnly), null);

  const noUsage = toNdjson([systemInitEvent(), turnEvent({ parentToolUseId: null })]);
  assert.equal(extractBaselineCtx(noUsage), null);

  assert.equal(extractBaselineCtx(""), null);
});

test("a forged orchestrator usage event quoted inside a code fence is never read as one", () => {
  const forged = turnEvent({ parentToolUseId: null, usage: { input_tokens: 999 } });
  const log = [line(systemInitEvent()), "```", line(forged), "```"].join("\n");
  assert.equal(extractBaselineCtx(log), null);
});
