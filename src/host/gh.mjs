import { execFile, spawnSync } from "node:child_process";

const CALL_TIMEOUT_MS = 20000;
const PR_VIEW_TIMEOUT_MS = 5000;
const PR_LIST_TIMEOUT_MS = 5000;
const PR_LIST_LIMIT = "5";
const PR_STATES = ["MERGED", "CLOSED", "OPEN"];
const MERGE_TIMEOUT_MS = 60000;
const PR_DETAIL_FIELDS = "state,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,mergeCommit,mergedAt,title,number,isDraft";
const STATUS_PENDING = new Set(["PENDING", "EXPECTED"]);
const CHECK_PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const LOGIN_RE = /\blogged in to \S+ (?:account|as) ([A-Za-z0-9][A-Za-z0-9-]*)/i;

// Path of the GitHub CLI, the resolver every call of this module goes through.
export function ghBin(env = process.env) {
  const raw = typeof env?.NIGHTQUEUE_GH_BIN === "string" ? env.NIGHTQUEUE_GH_BIN.trim() : "";
  return raw || "gh";
}

// Runs the GitHub CLI and never throws: a missing binary or a failure is a result the caller decides about.
export function runGh(args, { env = process.env, spawnSyncImpl = spawnSync, timeoutMs = CALL_TIMEOUT_MS, cwd } = {}) {
  let result;
  try {
    result = spawnSyncImpl(ghBin(env), args, { cwd, encoding: "utf8", timeout: timeoutMs, env });
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
function runGhAsync(args, { env = process.env, execFileImpl = execFile, timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
  return new Promise((done) => {
    const answer = (err, stdout, stderr) =>
      done({
        ok: !err,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" && stderr ? stderr : (err?.message ?? ""),
        missing: err?.code === "ENOENT",
      });
    try {
      execFileImpl(ghBin(env), args, { encoding: "utf8", timeout: timeoutMs, env, signal }, answer);
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

// Parses the json of `gh pr view`, keeping only the fields asked for; anything unexpected is undetermined.
function parsePrView(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!PR_STATES.includes(payload?.state)) return { ok: false };
  return {
    ok: true,
    state: payload.state,
    mergedAt: payload.mergedAt ?? null,
    mergeSha: payload.mergeCommit?.oid ?? null,
    mergeable: typeof payload.mergeable === "string" ? payload.mergeable : null,
    isDraft: payload.isDraft === true,
  };
}

// State of one pull request, read without blocking the event loop and never rejecting: `ok: false` means nobody could tell.
export async function ghPrViewAsync(url, { env = process.env, execFileImpl = execFile, timeoutMs = PR_VIEW_TIMEOUT_MS, signal } = {}) {
  const args = ["pr", "view", String(url ?? ""), "--json", "state,mergedAt,mergeCommit,mergeable,isDraft"];
  const result = await runGhAsync(args, { env, execFileImpl, timeoutMs, signal });
  return result.ok ? parsePrView(result.stdout) : { ok: false };
}

// Parses a json text, answering null instead of throwing.
function parseJson(text) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
}

// A trimmed string field of a payload, or null when it is absent or empty.
function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Parses the json of the detail read the close pipeline makes, keeping only the fields it asked for; an unknown state is undetermined.
function parsePrDetail(text) {
  const payload = parseJson(text);
  if (!PR_STATES.includes(payload?.state)) return { ok: false, error: "gh answered an unreadable pull request" };
  return {
    ok: true,
    state: payload.state,
    mergeable: textOrNull(payload.mergeable),
    mergeStateStatus: textOrNull(payload.mergeStateStatus),
    headRefName: textOrNull(payload.headRefName),
    headRefOid: textOrNull(payload.headRefOid),
    baseRefName: textOrNull(payload.baseRefName),
    mergeSha: textOrNull(payload.mergeCommit?.oid),
    mergedAt: textOrNull(payload.mergedAt),
    title: textOrNull(payload.title),
    number: Number.isInteger(payload.number) ? payload.number : null,
    isDraft: payload.isDraft === true,
  };
}

// Everything the close pipeline reads about one pull request, never rejecting: `ok: false` means nobody could tell.
export async function ghPrDetail(url, { env = process.env, execFileImpl = execFile, timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
  const args = ["pr", "view", String(url ?? ""), "--json", PR_DETAIL_FIELDS];
  const result = await runGhAsync(args, { env, execFileImpl, timeoutMs, signal });
  return result.ok ? parsePrDetail(result.stdout) : { ok: false, error: firstLine(result.stderr) };
}

// The first non-empty line of a text, or a placeholder naming its absence.
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0]?.trim() || "no output";
}

// The bucket of one entry of a status check rollup: `pass`, `pending` or `fail`.
function checkBucket(item) {
  if (typeof item?.state === "string") {
    if (STATUS_PENDING.has(item.state)) return "pending";
    return item.state === "SUCCESS" ? "pass" : "fail";
  }
  if (item?.status !== "COMPLETED") return "pending";
  return CHECK_PASSED.has(item?.conclusion) ? "pass" : "fail";
}

// Parses the status check rollup of a pull request; an empty rollup is no check at all, which is green.
function parsePrChecks(text) {
  const payload = parseJson(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rollup = payload.statusCheckRollup ?? [];
  if (!Array.isArray(rollup)) return null;
  const checks = rollup.map((item) => ({ name: textOrNull(item?.name) ?? textOrNull(item?.context) ?? "unnamed check", bucket: checkBucket(item) }));
  const named = (bucket) => checks.filter((check) => check.bucket === bucket).map((check) => check.name);
  return { ok: true, checks, failing: named("fail"), pending: named("pending") };
}

// The checks of one pull request, parsed from what gh printed even when it exited non-zero; never rejects.
export async function ghPrChecks(url, { env = process.env, execFileImpl = execFile, timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
  const result = await runGhAsync(["pr", "view", String(url ?? ""), "--json", "statusCheckRollup"], { env, execFileImpl, timeoutMs, signal });
  const parsed = parsePrChecks(result.stdout);
  return parsed ?? { ok: false, checks: [], failing: [], pending: [], error: firstLine(result.stderr) };
}

// Squash-merges one pull request, never deleting its branch; the answer is only reported, the merge is proven by a re-read.
export async function ghPrMerge(url, { matchHeadCommit = null, env = process.env, execFileImpl = execFile, timeoutMs = MERGE_TIMEOUT_MS, signal } = {}) {
  const args = ["pr", "merge", String(url ?? ""), "--squash"];
  if (textOrNull(matchHeadCommit)) args.push("--match-head-commit", textOrNull(matchHeadCommit));
  const result = await runGhAsync(args, { env, execFileImpl, timeoutMs, signal });
  return { ok: result.ok, stderr: result.stderr };
}

// The files one pull request changes, never rejecting: `ok: false` means nobody could tell.
export async function ghPrDiffNames(url, { env = process.env, execFileImpl = execFile, timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
  const result = await runGhAsync(["pr", "diff", String(url ?? ""), "--name-only"], { env, execFileImpl, timeoutMs, signal });
  if (!result.ok) return { ok: false, files: [], error: firstLine(result.stderr) };
  return { ok: true, files: result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) };
}

// Opens a pull request for a branch already on the remote; the URL it answers is information, never the record of the run.
export function ghPrCreate({ title, bodyFile, head, base, cwd, env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const args = ["pr", "create", "--title", String(title ?? ""), "--body-file", String(bodyFile ?? ""), "--head", String(head ?? "")];
  if (base) args.push("--base", String(base));
  const result = runGh(args, { env, spawnSyncImpl, cwd });
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return { ok: result.ok, url: result.ok ? (lines.at(-1) ?? null) : null, stderr: result.stderr, missing: result.missing };
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
