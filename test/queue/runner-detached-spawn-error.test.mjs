import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { launchDetachedRunner } from "../../src/queue/runner.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const CHILD_PID = 4242;

// A spawn double whose child is a real EventEmitter, so listener bookkeeping matches a real ChildProcess exactly.
function fakeSpawn() {
  const child = new EventEmitter();
  child.pid = CHILD_PID;
  child.unref = () => {};
  return { spawnImpl: () => child, child };
}

test("launchDetachedRunner attaches an error listener to the child, so a later async spawn failure never escapes as an uncaught exception", async (t) => {
  const env = makeHome(t, "runner-detached-spawn-error");
  const { spawnImpl, child } = fakeSpawn();

  const started = launchDetachedRunner({ env, spawnImpl });

  assert.equal(started.pid, CHILD_PID, "the launch itself reports success before any async failure could arrive");
  assert.equal(
    child.listenerCount("error"),
    1,
    "the child returned by spawnImpl must have exactly one error listener, or a later async EMFILE/ENOENT crashes whoever called launchDetachedRunner (CLI or the MCP server)",
  );
});
