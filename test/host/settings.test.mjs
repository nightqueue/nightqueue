import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUNTIME_PACKAGE_TRAIL } from "../../src/config/paths.mjs";
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
const [SESSION_START, PROMPT, SESSION_END, AGENT_FOREGROUND] = desiredHooks(ENV);
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
    { event: "PreToolUse", command: hookCommand("agent-foreground", ENV), timeout: 5, matcher: "Agent|Task|Bash|Read|Grep|Glob" },
  ]);
});

test("the merge appends one group per event and says so", () => {
  const data = {};
  assert.deepEqual(mergeHooks(data, ENV), [
    { event: "SessionStart", status: "created" },
    { event: "UserPromptSubmit", status: "created" },
    { event: "SessionEnd", status: "created" },
    { event: "PreToolUse", status: "created" },
  ]);
  assert.deepEqual(data.hooks.SessionStart, [
    { hooks: [{ type: "command", command: SESSION_START.command, timeout: SESSION_START.timeout }] },
  ]);
  assert.deepEqual(data.hooks.SessionEnd, [
    { hooks: [{ type: "command", command: SESSION_END.command, timeout: 15 }] },
  ]);
  assert.deepEqual(data.hooks.PreToolUse, [
    {
      matcher: "Agent|Task|Bash|Read|Grep|Glob",
      hooks: [{ type: "command", command: AGENT_FOREGROUND.command, timeout: AGENT_FOREGROUND.timeout }],
    },
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
    { event: "PreToolUse", status: "already present" },
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
    { event: "PreToolUse", status: "removed" },
  ]);
  assert.deepEqual(data, thirdPartySettings());
  assert.equal(data.hooks.PreToolUse, undefined, "the group PreToolUse held nothing but our own entry");

  removeHooks(clean, ENV);
  assert.deepEqual(clean, { hooks: {} });
  assert.deepEqual(removeHooks(clean, ENV), [
    { event: "SessionStart", status: "not present" },
    { event: "UserPromptSubmit", status: "not present" },
    { event: "SessionEnd", status: "not present" },
    { event: "PreToolUse", status: "not present" },
  ]);
});

test("the status of the hooks compares the registered command with the wanted one", () => {
  const data = thirdPartySettings();
  data.hooks.SessionEnd[0].hooks.push({ type: "command", command: "node /old/bin/nightshift.mjs hook reflect" });
  const status = hookStatus(data, ENV);
  assert.deepEqual(status[0], { event: "SessionStart", expected: SESSION_START.command, current: null, matcherCurrent: true });
  assert.deepEqual(status[2], {
    event: "SessionEnd",
    expected: SESSION_END.command,
    current: "node /old/bin/nightshift.mjs hook reflect",
    matcherCurrent: true,
  });
  assert.deepEqual(status[3], { event: "PreToolUse", expected: AGENT_FOREGROUND.command, current: null, matcherCurrent: true });
  mergeHooks(data, ENV);
  assert.equal(hookStatus(data, ENV)[2].current, SESSION_END.command);
  assert.equal(hookStatus(data, ENV)[3].current, AGENT_FOREGROUND.command);
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
  assert.ok(SESSION_START.command.endsWith(`${RUNTIME_PACKAGE_TRAIL}/bin/nightshift.mjs hook session-start`), SESSION_START.command);
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

test("the matcher of PreToolUse is written on a fresh merge", () => {
  const data = {};
  const [status] = mergeHooks(data, ENV).filter((entry) => entry.event === "PreToolUse");
  assert.equal(status.status, "created");
  assert.equal(data.hooks.PreToolUse[0].matcher, "Agent|Task|Bash|Read|Grep|Glob");
});

test("a wrong or missing matcher on our own group is repaired, and the repair counts as updated", () => {
  const wrong = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: AGENT_FOREGROUND.command, timeout: AGENT_FOREGROUND.timeout }] }] } };
  const [wrongStatus] = mergeHooks(wrong, ENV).filter((entry) => entry.event === "PreToolUse");
  assert.equal(wrongStatus.status, "updated");
  assert.equal(wrong.hooks.PreToolUse[0].matcher, "Agent|Task|Bash|Read|Grep|Glob");

  const missing = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: AGENT_FOREGROUND.command, timeout: AGENT_FOREGROUND.timeout }] }] } };
  const [missingStatus] = mergeHooks(missing, ENV).filter((entry) => entry.event === "PreToolUse");
  assert.equal(missingStatus.status, "updated");
  assert.equal(missing.hooks.PreToolUse[0].matcher, "Agent|Task|Bash|Read|Grep|Glob");
});

test("desiredHooks carries the orchestrator-scope matcher, the one source every consumer of the hook list reads", () => {
  const preToolUse = desiredHooks(ENV).filter((hook) => hook.event === "PreToolUse");
  assert.equal(preToolUse.length, 1);
  assert.equal(preToolUse[0].matcher, "Agent|Task|Bash|Read|Grep|Glob");
});

test("the status flags our own group registered with an older matcher, never a group shared with a third party", () => {
  const stale = { hooks: { PreToolUse: [{ matcher: "Agent|Task|Bash", hooks: [{ type: "command", command: AGENT_FOREGROUND.command, timeout: 5 }] }] } };
  assert.equal(hookStatus(stale, ENV)[3].matcherCurrent, false);
  mergeHooks(stale, ENV);
  assert.equal(hookStatus(stale, ENV)[3].matcherCurrent, true);

  const shared = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "other-tool guard" }, { type: "command", command: AGENT_FOREGROUND.command, timeout: 5 }] },
      ],
    },
  };
  assert.equal(hookStatus(shared, ENV)[3].matcherCurrent, true);
});

test("the matcher of a group shared with a third-party entry is left alone", () => {
  const data = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "other-tool guard" },
            { type: "command", command: AGENT_FOREGROUND.command, timeout: AGENT_FOREGROUND.timeout },
          ],
        },
      ],
    },
  };
  const [status] = mergeHooks(data, ENV).filter((entry) => entry.event === "PreToolUse");
  assert.equal(status.status, "already present");
  assert.equal(data.hooks.PreToolUse[0].matcher, "Bash", "a matcher shared with a third-party entry is never rewritten");
  assert.deepEqual(data.hooks.PreToolUse[0].hooks[0], { type: "command", command: "other-tool guard" });
});

test("the removal takes the PreToolUse entry out, event key included", () => {
  const data = {};
  mergeHooks(data, ENV);
  assert.ok(Array.isArray(data.hooks.PreToolUse));
  const [status] = removeHooks(data, ENV).filter((entry) => entry.event === "PreToolUse");
  assert.equal(status.status, "removed");
  assert.equal(data.hooks.PreToolUse, undefined);
});
