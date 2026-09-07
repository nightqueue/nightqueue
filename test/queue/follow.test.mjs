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

test("the follow delivers every line and ends itself as soon as the job stops running", async () => {
  const file = fakeFile("first\n");
  const writes = ["second\n", "third\n"];
  const { summary, lines } = await follow({
    file,
    readStatus: statusScript(["running", "running", "done"]),
    onEachPoll: () => file.append(writes.shift() ?? ""),
  });
  assert.deepEqual(lines, ["first", "second", "third"]);
  assert.deepEqual({ reason: summary.reason, status: summary.status, polls: summary.polls }, { reason: "job done", status: "done", polls: 3 });
});

test("the tail written in the very cycle the job finishes is delivered before the follow returns", async () => {
  const file = fakeFile("");
  const { lines, summary } = await follow({
    file,
    readStatus: statusScript(["running", "gate"]),
    onEachPoll: () => file.append("the last line\nand a partial one without a newline"),
  });
  assert.deepEqual(lines, ["the last line", "and a partial one without a newline"]);
  assert.equal(summary.status, "gate");
});

test("a job whose row is gone ends the follow instead of polling forever", async () => {
  const file = fakeFile("only line\n");
  const { summary, lines } = await follow({ file, readStatus: () => null });
  assert.deepEqual({ reason: summary.reason, status: summary.status, polls: summary.polls }, { reason: "unknown job", status: null, polls: 1 });
  assert.deepEqual(lines, ["only line"]);
});

test("a status that cannot be read is neither running nor finished: it ends the follow with the reason", async () => {
  const file = fakeFile("");
  const failing = await follow({
    file,
    readStatus: () => {
      throw new Error("database is locked");
    },
  });
  assert.match(failing.summary.reason, /^status unreadable: database is locked$/);
  assert.equal(failing.summary.status, null);
  assert.equal(failing.summary.polls, 5);

  let polls = 0;
  const recovering = await follow({
    file,
    readStatus: () => {
      polls += 1;
      if (polls < 8 && polls !== 4) throw new Error("database is locked");
      return polls < 8 ? "running" : "failed";
    },
  });
  assert.equal(recovering.summary.reason, "job failed");
});

test("a glitched read of the log is tolerated, delivered on the next poll and told to the operator once", async () => {
  const file = fakeFile("first\n");
  let reads = 0;
  const glitching = (...args) => {
    reads += 1;
    if (reads === 1) throw new Error("EIO: i/o error, read");
    return file.readChunk(...args);
  };
  const { lines, notices, summary } = await follow({
    file: { ...file, readChunk: glitching },
    readStatus: statusScript(["running", "done"]),
    onEachPoll: () => file.append("second\n"),
  });
  assert.deepEqual(lines, ["first", "second"]);
  assert.equal(summary.reason, "job done");
  assert.equal(summary.logError, null);
  assert.deepEqual(
    notices.filter((notice) => notice.kind === "error").map((notice) => notice.message),
    ["log read failed: EIO: i/o error, read"],
  );
});

test("a log that stays unreadable ends the follow, and a job that finishes meanwhile never claims a complete narration", async () => {
  const failing = await follow({
    file: {
      ...fakeFile("first\n"),
      statFn: () => {
        throw new Error("EACCES: permission denied, stat");
      },
    },
    readStatus: () => "running",
  });
  assert.equal(failing.summary.reason, "log unreadable: EACCES: permission denied, stat");
  assert.equal(failing.summary.status, null);
  assert.equal(failing.summary.polls, 5);
  assert.equal(failing.notices.filter((notice) => notice.kind === "error").length, 1);

  const file = fakeFile("first\n");
  let stats = 0;
  const vanishing = () => {
    stats += 1;
    if (stats > 1) throw new Error("ENOENT: no such file or directory, stat");
    return file.statFn();
  };
  const ending = await follow({ file: { ...file, statFn: vanishing }, readStatus: statusScript(["running", "done"]) });
  assert.equal(ending.summary.reason, "job done, log unreadable: ENOENT: no such file or directory, stat");
  assert.equal(ending.summary.logError, "log unreadable: ENOENT: no such file or directory, stat");
  assert.equal(ending.summary.status, "done");
});

test("a truncated log restarts the reading once, and does not deliver the old lines twice", async () => {
  const file = fakeFile("first\nsecond\n");
  const { lines, notices, summary } = await follow({
    file,
    readStatus: statusScript(["running", "done"]),
    onEachPoll: () => file.replace("restarted\n"),
  });
  assert.deepEqual(lines, ["first", "second", "restarted"]);
  assert.equal(notices.filter((notice) => notice.kind === "truncated").length, 1);
  assert.equal(summary.polls, 2);
});

test("a character split between two reads arrives whole", async () => {
  const whole = Buffer.from("a\u{1F600}b\n", "utf8");
  const file = fakeFile(whole.subarray(0, 3));
  const { lines } = await follow({
    file,
    readStatus: statusScript(["running", "done"]),
    onEachPoll: () => file.replace(whole),
  });
  assert.deepEqual(lines, ["a\u{1F600}b"]);
});

test("while the job runs and the log says nothing, the follow ticks instead of staying mute", async () => {
  const clock = { now: 0 };
  const file = fakeFile("one line\n");
  const { notices } = await follow({
    file,
    clock,
    readStatus: statusScript(["running", "running", "running", "done"]),
    onEachPoll: () => {
      clock.now += 20000;
    },
  });
  const quiet = notices.filter((notice) => notice.kind === "quiet");
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].silentMs, 40000);
});

test("an output nobody reads anymore ends the follow with its own reason", async () => {
  const file = fakeFile("one line\n");
  const { summary, lines } = await follow({ file, readStatus: statusScript(["running"]), stopReason: () => "output closed" });
  assert.deepEqual({ reason: summary.reason, status: summary.status, polls: summary.polls }, { reason: "output closed", status: null, polls: 1 });
  assert.deepEqual(lines, ["one line"]);
});

test("every poll reports the offset and the size, the trace that catches a stream that went quiet", async () => {
  const file = fakeFile("first\n");
  const { notices } = await follow({ file, readStatus: statusScript(["running", "done"]), onEachPoll: () => file.append("second\n") });
  const polls = notices.filter((notice) => notice.kind === "poll");
  assert.deepEqual(polls.map((notice) => ({ size: notice.size, offset: notice.offset, lines: notice.lines })), [
    { size: 6, offset: 6, lines: 1 },
    { size: 13, offset: 13, lines: 1 },
  ]);
  assert.match(polls[0].at, /^\d{4}-\d{2}-\d{2}T/);
});
