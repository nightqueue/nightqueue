import assert from "node:assert/strict";
import { test } from "node:test";
import { followLog } from "../../src/queue/follow.mjs";

const PATH = "/nowhere/job-1.log";
const MAX_POLLS = 20;

// A file that only exists in memory: the follow reaches it through the injected stat and read.
function fakeFile(initial = "") {
  let bytes = Buffer.isBuffer(initial) ? initial : Buffer.from(initial, "utf8");
  return {
    append: (text) => {
      bytes = Buffer.concat([bytes, Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8")]);
    },
    replace: (text) => {
      bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
    },
    statFn: () => ({ size: bytes.length }),
    readChunk: (_path, from, length) => bytes.subarray(from, from + length),
  };
}

// A status reader that answers one status per poll and repeats the last one forever.
function statusScript(statuses) {
  let index = 0;
  return () => statuses[Math.min(index++, statuses.length - 1)];
}

// Runs a follow with every dependency injected, so the test never waits a single millisecond.
function follow({ file, readStatus, onEachPoll = () => {}, clock = { now: 0 }, ...rest }, deps = {}) {
  const lines = [];
  const notices = [];
  let polls = 0;
  const result = followLog(
    { path: PATH, readStatus, onLine: (line) => lines.push(line), onNotice: (notice) => notices.push(notice), ...rest },
    {
      sleep: async () => {
        polls += 1;
        if (polls > MAX_POLLS) throw new Error(`the follow polled ${polls} times without ending`);
        onEachPoll();
      },
      now: () => clock.now,
      statFn: file.statFn,
      readChunk: file.readChunk,
      ...deps,
    },
  );
  return result.then((summary) => ({ summary, lines, notices }));
}

test("a stat that works for a while and then always throws is reported, not swallowed as a clean job end", async () => {
  const file = fakeFile("first\n");
  let statCalls = 0;
  const flakyStatFn = () => {
    statCalls += 1;
    if (statCalls > 2) throw new Error("ENOENT: no such file or directory");
    return file.statFn();
  };
  const { summary, notices, lines } = await follow({
    file: { ...file, statFn: flakyStatFn },
    readStatus: statusScript(["running", "running", "running", "running", "done"]),
    onEachPoll: () => file.append("lost line\n"),
  });

  const hasErrorNotice = notices.some((notice) => /error|fail/i.test(String(notice.kind ?? "")));
  const reasonMentionsLogFailure = /log/i.test(summary.reason ?? "");
  assert.ok(
    hasErrorNotice || reasonMentionsLogFailure,
    `a persistent stat failure on the log file must surface somewhere (a notice or the final reason), ` +
      `but it did not: reason="${summary.reason}", notices=${JSON.stringify(notices)}`,
  );
});
