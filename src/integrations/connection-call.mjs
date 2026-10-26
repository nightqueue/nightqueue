// The runtime side of `connection_call`: reaches the API behind a stored connection by its name with the secret injected here and never answered; no service is named here, each provider declares its own call rules.
import { refuseConnectionWriteInsideJob } from "../queue/home-guard.mjs";
import { connectionScope, consentCovers, operatorSession } from "../queue/operator-consent.mjs";
import { connectionRecord } from "./connections.mjs";
import { quietFiles } from "./coverage.mjs";
import { requestJson } from "./http.mjs";
import { redactSecrets, redactValue } from "./redact.mjs";
import { providerOf } from "./registry.mjs";

export const CONNECTION_CALL_METHODS = Object.freeze(["GET", "POST", "PATCH", "PUT"]);
export const CONNECTION_CALL_BOUNDS = Object.freeze({ path: 2000, body: 50_000, answer: 50_000, timeoutMs: 10_000, depth: 256 });

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FORBIDDEN_CHARS = /[\\?#\s\x00-\x1f\x7f]/;
const ENCODED_SEPARATORS = /%(?:2e|2f|5c)/i;
const DOT_SEGMENTS = new Set([".", ".."]);
const MAY_HAVE_APPLIED = "; it may still have been applied - check before trying again";
const NO_CONNECTION = "no stored connection named that way; the person lists them with `nightqueue connection list`";
const NO_API = "this connection's kind has no API the runtime can call";
const BAD_ROOT = "this connection's stored address is not a valid URL";
const PATH_RULE = "path is relative to the connection's API root: no scheme, no leading `//`, no `.` or `..` segment, no `\\`, `?`, `#`, whitespace or encoded `.`, `/` or `\\`, at most 2,000 characters";
const QUERY_RULE = "query is an object whose values are a string, a number, a boolean or a list of strings";

// A refusal answered as a normal tool answer, never as an error; its detail never echoes the input.
function refused(error, detail) {
  return { ok: false, error, status: null, detail };
}

// A refusal of the call's own input.
function invalid(detail) {
  return refused("invalid-input", detail);
}

// The upper-case method of the call, GET when none is given.
function methodOf(args) {
  return String(args?.method ?? "GET").trim().toUpperCase();
}

// The serialized body of the call, null when there is none, or the refusal of a body that cannot be sent.
function serializedBody(method, body) {
  if (body === undefined || body === null) return { text: null };
  if (method === "GET") return { refusal: invalid("a GET carries no body") };
  let text;
  try {
    text = JSON.stringify(body);
  } catch {
    return { refusal: invalid("body is not serializable as JSON") };
  }
  if (typeof text !== "string") return { refusal: invalid("body is not serializable as JSON") };
  if (text.length > CONNECTION_CALL_BOUNDS.body) return { refusal: invalid("body is longer than 50,000 characters serialized") };
  return { text };
}

// The stored record of a connection by name and its provider, or the refusal of a name that cannot be called.
function resolveConnection(env, name) {
  const key = typeof name === "string" ? name.trim() : "";
  const connections = quietFiles(env).secrets?.connections;
  if (!key || !connections || !Object.hasOwn(connections, key)) return { refusal: refused("no-connection", NO_CONNECTION) };
  const secrets = { connections };
  const record = connectionRecord({ secrets, name: key, kind: connections[key]?.type });
  if (!record) return { refusal: refused("no-connection", NO_CONNECTION) };
  const provider = providerOf(record.type);
  if (typeof provider?.apiRoot !== "function" || typeof provider?.authHeaders !== "function") return { refusal: refused("provider-unavailable", NO_API) };
  return { record, provider };
}

// Tells whether a path could leave the connection's API root.
function isUnsafePath(path) {
  if (path.length > CONNECTION_CALL_BOUNDS.path) return true;
  if (SCHEME.test(path) || path.startsWith("//")) return true;
  if (FORBIDDEN_CHARS.test(path) || ENCODED_SEPARATORS.test(path)) return true;
  return path.split("/").some((segment) => DOT_SEGMENTS.has(segment));
}

// The path relative to the API root with one leading slash removed, or the refusal of a path this kind does not take.
function relativePath(path, call) {
  const given = path ?? "";
  if (typeof given !== "string") return { refusal: invalid(PATH_RULE) };
  if (call?.path === false) return given === "" || given === "/" ? { path: "" } : { refusal: invalid("this connection's kind takes no path") };
  if (isUnsafePath(given)) return { refusal: invalid(PATH_RULE) };
  const relative = given.replace(/^\//, "");
  if (call?.path instanceof RegExp && relative !== "" && !call.path.test(relative)) return { refusal: invalid("this connection's kind takes only the path its API documents") };
  return { path: relative };
}

// The refusal of a method this connection's kind does not take at this path, or null.
function methodProblem(method, path, call) {
  const allowed = typeof call?.methodsAt === "function" ? call.methodsAt(path) : null;
  if (!Array.isArray(allowed) || allowed.includes(method)) return null;
  return invalid(`this path takes only ${allowed.join(", ")}`);
}

// The parsed API root of a connection, or null when the stored address is not a URL.
function parsedRoot(provider, record) {
  try {
    return new URL(provider.apiRoot(record));
  } catch {
    return null;
  }
}

// The URL of the call pinned under the API root, or null when it would land anywhere else.
function pinnedUrl(root, path) {
  if (!path) return new URL(root.href);
  const base = root.href.endsWith("/") ? root : new URL(`${root.href}/`);
  let url;
  try {
    url = new URL(path, base);
  } catch {
    return null;
  }
  return url.origin === base.origin && url.href.startsWith(base.href) ? url : null;
}

// Tells whether one query value is a text, a finite number, a boolean or a list of texts.
function isQueryValue(value) {
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

// Appends the query to the URL, or answers the detail of a query this call does not take.
function applyQuery(url, query, call) {
  if (query === undefined || query === null) return null;
  if (typeof query !== "object" || Array.isArray(query)) return QUERY_RULE;
  const entries = Object.entries(query);
  if (!entries.every(([, value]) => isQueryValue(value))) return QUERY_RULE;
  const allowed = Array.isArray(call?.query) ? call.query : null;
  if (allowed && entries.some(([key]) => !allowed.includes(key))) return `query takes only ${allowed.join(", ")}`;
  for (const [key, value] of entries) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return null;
}

// The secret values of this call beyond the home's: the record's secret fields and the parts of them its provider names.
function callSecrets(provider, record) {
  const fields = Array.isArray(provider.connection?.secretFields) ? provider.connection.secretFields : [];
  const parts = typeof provider.call?.secretParts === "function" ? provider.call.secretParts(record) : [];
  return [...fields.map((field) => record[field]), ...(Array.isArray(parts) ? parts : [])];
}

// The answer of a call the provider refused or that never got an answer; never the provider's message, URL or headers.
function failureAnswer(answer, method) {
  const unsure = method !== "GET" && (answer.status === null || answer.status >= 500);
  return { ok: false, error: "provider-unavailable", status: answer.status ?? null, detail: `${answer.detail}${unsure ? MAY_HAVE_APPLIED : ""}` };
}

// The body of a text answer kept in its shape when it fits: null, the text itself, or the parsed value.
function fittedBody(redacted, text) {
  if (redacted === null || redacted === undefined) return null;
  if (typeof redacted === "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Tells whether a parsed body nests deeper than the answer can walk, measured without recursion.
function isTooDeep(body) {
  const pending = [[body, 0]];
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (depth >= CONNECTION_CALL_BOUNDS.depth) return true;
    for (const item of Object.values(value)) pending.push([item, depth + 1]);
  }
  return false;
}

// The answer of a successful call: the body redacted whole, then cut at 50,000 characters; a body nested too deep is answered as its raw text.
function successAnswer(answer, env, also) {
  const body = isTooDeep(answer.body) ? String(answer.text ?? "") : answer.body;
  const redacted = redactValue(body, env, { also });
  const serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted ?? null);
  const text = redactSecrets(serialized, env, { also });
  if (text.length <= CONNECTION_CALL_BOUNDS.answer) return { ok: true, status: answer.status, body: fittedBody(redacted, text) };
  return { ok: true, status: answer.status, body: text.slice(0, CONNECTION_CALL_BOUNDS.answer), body_truncated: true };
}

// The connection, URL and body of the call, or the refusal of an input that cannot be sent.
function preparedCall(args, method, env) {
  const body = serializedBody(method, args?.body);
  if (body.refusal) return body;
  const target = resolveConnection(env, args?.connection);
  if (target.refusal) return target;
  const relative = relativePath(args?.path, target.provider.call);
  if (relative.refusal) return relative;
  const wrongMethod = methodProblem(method, relative.path, target.provider.call);
  if (wrongMethod) return { refusal: wrongMethod };
  const root = parsedRoot(target.provider, target.record);
  if (!root) return { refusal: refused("provider-unavailable", BAD_ROOT) };
  const url = pinnedUrl(root, relative.path);
  if (!url) return { refusal: invalid(PATH_RULE) };
  const queryProblem = applyQuery(url, args?.query, target.provider.call);
  if (queryProblem) return { refusal: invalid(queryProblem) };
  return { ...target, url, body: body.text === null ? undefined : args.body };
}

// The refusal of a write an operator session sends with no live connection-write consent covering it, or null (always outside an operator session).
function missingConsent(args, method, env) {
  const session = operatorSession(env);
  if (session === null) return null;
  const scope = connectionScope({ connection: args?.connection, method, path: typeof args?.path === "string" ? args.path : "" });
  try {
    if (consentCovers(session, { kind: "connection-write", scope }, env)) return null;
  } catch (err) {
    return refused("needs-consent", `the consent record could not be read (${err?.message ?? String(err)}), so the write is refused; nothing was sent`);
  }
  return refused(
    "needs-consent",
    `needs consent (connection-write ${scope}): show the person the exact request, record their answer with operator_consent, then call again; nothing was sent`,
  );
}

// Calls the API behind a stored connection and answers { ok, status, body, body_truncated? } or { ok: false, error, status, detail }.
export async function connectionCall(args, { env, fetchImpl = globalThis.fetch } = {}) {
  const method = methodOf(args);
  if (!CONNECTION_CALL_METHODS.includes(method)) return invalid("method is GET, POST, PATCH or PUT");
  if (method !== "GET") refuseConnectionWriteInsideJob(env, method);
  const unconsented = method === "GET" ? null : missingConsent(args, method, env);
  if (unconsented) return unconsented;
  const call = preparedCall(args, method, env);
  if (call.refusal) return call.refusal;
  const headers = call.provider.authHeaders(call.record);
  const answer = await requestJson(fetchImpl, call.url.href, { method, headers, body: call.body, timeoutMs: CONNECTION_CALL_BOUNDS.timeoutMs, lenient: true });
  if (!answer.ok) return failureAnswer(answer, method);
  return successAnswer(answer, env, callSecrets(call.provider, call.record));
}
