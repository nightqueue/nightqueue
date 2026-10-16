import { existsSync } from "node:fs";
import { join } from "node:path";
import { easAccountStatus, easBin, easUpdateGroupUrl, parseEasProjectFullName } from "../host/eas.mjs";

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const OTA_BUDGET_S = 600;
const PROJECT_INFO_TIMEOUT_MS = 30000;

// The update group id of the JSON `eas update --json` printed, or null when it carries none.
function updateGroupOf(stdout) {
  try {
    const updates = JSON.parse(String(stdout ?? ""));
    const group = Array.isArray(updates) ? updates[0]?.group : null;
    return typeof group === "string" && group ? group : null;
  } catch {
    return null;
  }
}

// Why an `eas update` call published nothing.
function updateFailure(result, signal) {
  if (result.unfinished && signal?.aborted) return "eas update was interrupted";
  if (result.unfinished) return `eas update passed its budget of ${OTA_BUDGET_S}s`;
  if (result.missing) return "eas is not installed";
  return result.ok ? "eas answered no update group" : `eas update exited ${result.code ?? "with an error"}`;
}

// The expo.dev page of an update group, from `eas project:info` in the same directory, or null when it cannot be told.
async function updateGroupUrl({ dir, group, eas, timeoutMs, signal }) {
  if (typeof eas?.projectInfo !== "function") return null;
  try {
    const info = await eas.projectInfo(["project:info"], { cwd: dir, timeoutMs: Math.max(1, Math.min(PROJECT_INFO_TIMEOUT_MS, timeoutMs)), signal });
    const name = info?.ok ? parseEasProjectFullName(info.stdout) : null;
    return name ? easUpdateGroupUrl(name.owner, name.slug, group) : null;
  } catch {
    return null;
  }
}

// Publishes an OTA update of a directory to a branch through eas, answering { ok, groupId, url } or { ok: false, reason, output }.
async function publishOta({ dir, branch, message, eas, timeoutMs, signal }) {
  const args = ["update", "--branch", branch, "--message", message, "--non-interactive", "--json"];
  const started = Date.now();
  const result = await eas.update(args, { cwd: dir, timeoutMs, signal });
  const group = result?.ok ? updateGroupOf(result.stdout) : null;
  if (!group) return { ok: false, reason: updateFailure(result ?? {}, signal), output: `${result?.stdout ?? ""}\n${result?.stderr ?? ""}` };
  const left = timeoutMs - (Date.now() - started);
  const url = left > 0 && !signal?.aborted ? await updateGroupUrl({ dir, group, eas, timeoutMs: left, signal }) : null;
  return { ok: true, groupId: group, url };
}

// Tells whether a checkout is an Expo project, by an eas.json at its root.
function detectExpo(checkout) {
  if (typeof checkout !== "string" || !checkout) return false;
  try {
    return existsSync(join(checkout, "eas.json"));
  } catch {
    return false;
  }
}

export const expo = {
  kind: "expo",
  label: "Expo",
  description: "Publishes an Expo OTA update of each merged job through the machine's eas login, for the projects that turn it on.",
  card: { order: 2, icon: "expo" },
  ambient: {
    status: (env) => easAccountStatus({ env }),
    connect: (env) => ({ bin: easBin(env), args: ["login"] }),
    command: "eas login",
    hint: "nightqueue uses the machine's eas login; run `eas login`",
  },
  settings: {
    ota: { type: "boolean", default: false },
    branch: { type: "text", default: "production", pattern: BRANCH_RE, format: "a branch name such as production" },
  },
  detect: detectExpo,
  ota: { budgetS: OTA_BUDGET_S, publish: publishOta },
};
