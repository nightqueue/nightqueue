import { spawnSync } from "node:child_process";

const CALL_TIMEOUT_MS = 20000;
const PR_VIEW_TIMEOUT_MS = 5000;
const PR_STATES = ["MERGED", "CLOSED", "OPEN"];
const LOGIN_RE = /\blogged in to \S+ (?:account|as) ([A-Za-z0-9][A-Za-z0-9-]*)/i;

// Path of the GitHub CLI, the resolver every call of this module goes through.
export function ghBin(env = process.env) {
  const raw = typeof env?.NIGHTSHIFT_GH_BIN === "string" ? env.NIGHTSHIFT_GH_BIN.trim() : "";
  return raw || "gh";
}

// Runs the GitHub CLI and never throws: a missing binary or a failure is a result the caller decides about.
function runGh(args, { env = process.env, spawnSyncImpl = spawnSync, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = spawnSyncImpl(ghBin(env), args, { encoding: "utf8", timeout: timeoutMs, env });
  } catch (err) {
    return { ok: false, stdout: "", stderr: err?.message ?? String(err), missing: err?.code === "ENOENT" };
  }
  const failure = result?.error ?? null;
  return {
    ok: !failure && result?.status === 0,
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" && result.stderr ? result.stderr : (failure?.message ?? ""),
    missing: failure?.code === "ENOENT",
  };
}

// Account name the GitHub CLI reports as logged in, or null when the text carries none.
export function parseGhLogin(text) {
  const match = LOGIN_RE.exec(String(text ?? ""));
  return match ? match[1] : null;
}

// Tells whether the GitHub CLI is installed and authenticated, and for which account.
export function ghAuthStatus({ env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const result = runGh(["auth", "status"], { env, spawnSyncImpl });
  return {
    authenticated: result.ok,
    login: parseGhLogin(`${result.stdout}\n${result.stderr}`),
    missing: result.missing,
  };
}

// Parses the json of `gh pr view`, keeping only the three fields asked for; anything unexpected is undetermined.
function parsePrView(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!PR_STATES.includes(payload?.state)) return { ok: false };
  return { ok: true, state: payload.state, mergedAt: payload.mergedAt ?? null, mergeSha: payload.mergeCommit?.oid ?? null };
}

// Merge state of one pull request, as a tri-state: `ok: false` means nobody could tell, never "not merged".
export function ghPrView(url, { env = process.env, spawnSyncImpl = spawnSync, timeoutMs = PR_VIEW_TIMEOUT_MS } = {}) {
  const result = runGh(["pr", "view", url, "--json", "state,mergedAt,mergeCommit"], { env, spawnSyncImpl, timeoutMs });
  return result.ok ? parsePrView(result.stdout) : { ok: false };
}

// Reads the token of the GitHub CLI, returning the value and nothing else the caller could print by accident.
export function ghAuthToken({ env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const result = runGh(["auth", "token"], { env, spawnSyncImpl });
  const token = result.ok ? result.stdout.trim() : "";
  return token ? { ok: true, token } : { ok: false, token: null };
}
