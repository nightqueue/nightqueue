import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostPackageRoot } from "../../src/host/paths.mjs";
import {
  desiredHooks,
  hookCommand,
  hookStatus,
  mergeHooks,
  removeHooks,
  spacedRootWarning,
} from "../../src/host/settings.mjs";

const ENV = { NIGHTSHIFT_HOME: join(tmpdir(), "nightshift-settings-fixture") };
const [SESSION_START, PROMPT, SESSION_END] = desiredHooks(ENV);
const LEGACY_SESSION_START = `node ${join(hostPackageRoot(ENV), "bin", "shift.mjs")} hook session-start`;

// Settings fixture with one third-party hook per event.
function thirdPartySettings() {
  return {
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "other session", timeout: 20 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "other prompt", timeout: 15 }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "other end", timeout: 5 }] }],
      Stop: [{ hooks: [{ type: "command", command: "other stop", timeout: 10 }] }],
    },
  };
}

test("each event carries its own timeout, and the reflection gets the longest one", () => {
  assert.deepEqual(desiredHooks(ENV), [
    { event: "SessionStart", command: hookCommand("session-start", ENV), timeout: 10 },
    { event: "UserPromptSubmit", command: hookCommand("prompt-context", ENV), timeout: 10 },
    { event: "SessionEnd", command: hookCommand("reflect", ENV), timeout: 15 },
  ]);
});

test("the merge appends one group per event and says so", () => {
  const data = {};
  assert.deepEqual(mergeHooks(data, ENV), [
    { event: "SessionStart", status: "created" },
    { event: "UserPromptSubmit", status: "created" },
    { event: "SessionEnd", status: "created" },
  ]);
  assert.deepEqual(data.hooks.SessionStart, [
    { hooks: [{ type: "command", command: SESSION_START.command, timeout: SESSION_START.timeout }] },
  ]);
  assert.deepEqual(data.hooks.SessionEnd, [
    { hooks: [{ type: "command", command: SESSION_END.command, timeout: 15 }] },
  ]);
});

test("a second merge changes nothing and reports every event as already present", () => {
  const data = thirdPartySettings();
  mergeHooks(data, ENV);
  const snapshot = structuredClone(data);
  assert.deepEqual(mergeHooks(data, ENV), [
    { event: "SessionStart", status: "already present" },
    { event: "UserPromptSubmit", status: "already present" },
    { event: "SessionEnd", status: "already present" },
  ]);
  assert.deepEqual(data, snapshot);
});

test("a stale command is repaired in place, keeping the matcher and the neighbours", () => {
  const data = thirdPartySettings();
  data.hooks.SessionStart[0].hooks.push({ type: "command", command: "node /old/bin/nightshift.mjs hook session-start" });
  const [first] = mergeHooks(data, ENV);
  assert.equal(first.status, "updated");
  assert.equal(data.hooks.SessionStart.length, 1);
  assert.equal(data.hooks.SessionStart[0].matcher, "startup");
  assert.deepEqual(data.hooks.SessionStart[0].hooks[0], { type: "command", command: "other session", timeout: 20 });
  assert.deepEqual(data.hooks.SessionStart[0].hooks[1], {
    type: "command",
    command: SESSION_START.command,
    timeout: SESSION_START.timeout,
  });
});

test("duplicated entries left by a hand edit collapse into one", () => {
  const data = { hooks: { UserPromptSubmit: [] } };
  for (let index = 0; index < 3; index += 1) {
    data.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: PROMPT.command, timeout: 1 }] });
  }
  const status = mergeHooks(data, ENV).find((step) => step.event === "UserPromptSubmit");
  assert.equal(status.status, "updated");
  assert.deepEqual(data.hooks.UserPromptSubmit, [
    { hooks: [{ type: "command", command: PROMPT.command, timeout: PROMPT.timeout }] },
  ]);
});

test("the removal drops the event key only when nothing else is left in it", () => {
  const data = thirdPartySettings();
  mergeHooks(data, ENV);
  const clean = { hooks: {} };
  mergeHooks(clean, ENV);

  assert.deepEqual(removeHooks(data, ENV), [
    { event: "SessionStart", status: "removed" },
    { event: "UserPromptSubmit", status: "removed" },
    { event: "SessionEnd", status: "removed" },
  ]);
  assert.deepEqual(data, thirdPartySettings());

  removeHooks(clean, ENV);
  assert.deepEqual(clean, { hooks: {} });
  assert.deepEqual(removeHooks(clean, ENV), [
    { event: "SessionStart", status: "not present" },
    { event: "UserPromptSubmit", status: "not present" },
    { event: "SessionEnd", status: "not present" },
  ]);
});

test("the status of the hooks compares the registered command with the wanted one", () => {
  const data = thirdPartySettings();
  data.hooks.SessionEnd[0].hooks.push({ type: "command", command: "node /old/bin/nightshift.mjs hook reflect" });
  const status = hookStatus(data, ENV);
  assert.deepEqual(status[0], { event: "SessionStart", expected: SESSION_START.command, current: null });
  assert.deepEqual(status[2], {
    event: "SessionEnd",
    expected: SESSION_END.command,
    current: "node /old/bin/nightshift.mjs hook reflect",
  });
  mergeHooks(data, ENV);
  assert.equal(hookStatus(data, ENV)[2].current, SESSION_END.command);
});

test("a package path with a space is reported, because the hook command is not quoted", () => {
  const warning = spacedRootWarning("/Users/someone/My Tools/nightshift");
  assert.match(warning, /^nightshift: warning: the package path contains a space/);
  assert.ok(warning.includes("/Users/someone/My Tools/nightshift"), warning);
  assert.match(warning, /hook command/);
});

test("a runtime path without a space is silent, and so is a root nobody passed", () => {
  assert.equal(spacedRootWarning("/Users/someone/tools/nightshift"), null);
  assert.equal(spacedRootWarning(hostPackageRoot(ENV)), null);
  assert.equal(spacedRootWarning(), null);
});

test("the hooks of the host point at the runtime of the home, never at the checkout that ran the setup", () => {
  assert.equal(SESSION_START.command.includes(hostPackageRoot(ENV)), true, SESSION_START.command);
  assert.match(SESSION_START.command, /runtime\/node_modules\/nightshift\/bin\/nightshift\.mjs hook session-start$/);
});

test("an event holding something that is not an array is rebuilt without touching the others", () => {
  const data = { hooks: { SessionStart: "broken", Stop: thirdPartySettings().hooks.Stop } };
  mergeHooks(data, ENV);
  assert.equal(data.hooks.SessionStart[0].hooks[0].command, SESSION_START.command);
  assert.deepEqual(data.hooks.Stop, thirdPartySettings().hooks.Stop);
});

test("an entry left by the previous command name is updated in place, never duplicated", () => {
  const data = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: LEGACY_SESSION_START, timeout: 10 }] }],
    },
  };
  assert.deepEqual(mergeHooks(data, ENV)[0], { event: "SessionStart", status: "updated" });
  assert.equal(data.hooks.SessionStart.length, 1);
  assert.deepEqual(data.hooks.SessionStart[0].hooks, [{ type: "command", command: SESSION_START.command, timeout: 10 }]);
});

test("a host carrying the previous entry and the current one ends with a single entry per event", () => {
  const data = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: LEGACY_SESSION_START, timeout: 10 }] },
        { hooks: [{ type: "command", command: SESSION_START.command, timeout: 10 }] },
      ],
    },
  };
  assert.deepEqual(mergeHooks(data, ENV)[0], { event: "SessionStart", status: "updated" });
  assert.equal(data.hooks.SessionStart.length, 1);
  assert.deepEqual(data.hooks.SessionStart[0].hooks, [{ type: "command", command: SESSION_START.command, timeout: 10 }]);
});

test("the removal also takes out an entry left by the previous command name", () => {
  const data = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: LEGACY_SESSION_START, timeout: 10 }] }],
    },
  };
  assert.deepEqual(removeHooks(data, ENV)[0], { event: "SessionStart", status: "removed" });
  assert.equal(data.hooks.SessionStart, undefined);
});
