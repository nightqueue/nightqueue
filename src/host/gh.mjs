import { execFile, spawnSync } from "node:child_process";

const CALL_TIMEOUT_MS = 20000;
const PR_VIEW_TIMEOUT_MS = 5000;
const PR_LIST_TIMEOUT_MS = 5000;
const PR_LIST_LIMIT = "5";
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

// Runs the GitHub CLI without ever blocking the event loop and without ever rejecting: a missing binary, a failure and a
// timeout are results the caller decides about, exactly as the synchronous wrapper reports them.
function runGhAsync(args, { env = process.env, execFileImpl = execFile, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    const answer = (err, stdout, stderr) =>
      done({
        ok: !err,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" && stderr ? stderr : (err?.message ?? ""),
        missing: err?.code === "ENOENT",
      });
    try {
      execFileImpl(ghBin(env), args, { encoding: "utf8", timeout: timeoutMs, env }, answer);
    } catch (err) {
      answer(err, "", "");
    }
  });
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

// Trimmed text of a field of the json, or the placeholder when gh answered without it.
function prField(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "unknown";
}

// Parses the json of `gh pr list`, keeping only the three fields asked for; anything unexpected is undetermined.
function parsePrList(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(payload)) return null;
  return payload
    .filter((item) => typeof item?.url === "string" && item.url.trim())
    .map((item) => ({ title: prField(item.title), url: item.url.trim(), branch: prField(item.headRefName) }));
}

// Open pull requests matching a search, or null when nobody could tell: a missing, unauthenticated or slow gh is never "there
// are none". The call is asynchronous on purpose - it sits on the hot path of the runner, where a synchronous spawn would
// freeze the dispatch loop and every sibling job's I/O for as long as gh takes to answer.
export async function ghPrList(query, { env = process.env, execFileImpl = execFile, timeoutMs = PR_LIST_TIMEOUT_MS } = {}) {
  const search = typeof query === "string" ? query.trim() : "";
  if (!search) return null;
  const args = ["pr", "list", "--search", search, "--state", "open", "--json", "title,url,headRefName", "--limit", PR_LIST_LIMIT];
  const result = await runGhAsync(args, { env, execFileImpl, timeoutMs });
  return result.ok ? parsePrList(result.stdout) : null;
}

// Reads the token of the GitHub CLI, returning the value and nothing else the caller could print by accident.
export function ghAuthToken({ env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const result = runGh(["auth", "token"], { env, spawnSyncImpl });
  const token = result.ok ? result.stdout.trim() : "";
  return token ? { ok: true, token } : { ok: false, token: null };
}
