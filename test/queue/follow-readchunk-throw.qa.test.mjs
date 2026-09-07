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

test("a log file that stops being readable ends the follow with a clear reason instead of crashing the process", async () => {
  const file = fakeFile("first\n");
  const brokenReadChunk = () => {
    throw new Error("EACCES: permission denied, read");
  };
  const promise = follow({
    file: { ...file, readChunk: brokenReadChunk },
    readStatus: statusScript(["running", "running", "done"]),
    onEachPoll: () => file.append("more\n"),
  });

  await assert.doesNotReject(
    promise,
    "followLog must end gracefully (like it does for an unreadable status) instead of letting the read exception escape uncaught",
  );
  const { summary } = await promise;
  assert.match(summary.reason ?? "", /log/i, `expected the reason to mention the broken log read, got "${summary.reason}"`);
});

test("a single glitched read of the log does not abort the whole follow session", async () => {
  const file = fakeFile("first\n");
  let calls = 0;
  const flakyReadChunk = (...args) => {
    calls += 1;
    if (calls === 2) throw new Error("EIO: i/o error, read");
    return file.readChunk(...args);
  };

  let outcome;
  try {
    outcome = await follow({
      file: { ...file, readChunk: flakyReadChunk },
      readStatus: statusScript(["running", "running", "running", "done"]),
      onEachPoll: () => file.append("second\n"),
    });
  } catch (err) {
    assert.fail(`a single transient read glitch should not abort the whole follow session, but it threw: ${err.message}`);
  }

  assert.deepEqual(
    outcome.lines,
    ["first", "second", "second", "second"],
    "the glitched read must be retried and nothing lost: the fake appends one line per poll and the follow polls four times",
  );
  assert.equal(outcome.summary.reason, "job done");
});
