// The only HTTP path of the integrations: a failure answers a status or a fixed detail, never an error message, URL or header; the JSON body of a refusal is kept apart as `errorBody` for the one caller that vets it.

// Combines the per-request timeout with an optional caller signal.
function requestSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

// Builds the fetch options of a request, serializing a JSON body when one is given.
function requestOptions({ method, headers, body, timeoutMs, signal }) {
  const options = { method, headers: { ...headers }, redirect: "manual", signal: requestSignal(timeoutMs, signal) };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return options;
}

// Turns a thrown fetch error into a detail that carries no message of the error.
function failureDetail(err, timeoutMs) {
  const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
  return timedOut ? `timeout (${Math.round(timeoutMs / 1000)}s)` : "network failure";
}

// Reads the JSON body of a refused answer, or null when it has none; only a caller that vets it (Discord) may surface it.
async function readErrorBody(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Reads a successful body leniently with its raw text: null when empty, the parsed value when it is JSON, the text itself otherwise.
async function readLenientBody(res) {
  const text = await res.text();
  if (!text) return { body: null, text: "" };
  try {
    return { body: JSON.parse(text), text };
  } catch {
    return { body: text, text };
  }
}

// The successful answer of a request: the parsed JSON, or with `lenient` the lenient body and its raw text.
async function successBody(res, lenient) {
  if (lenient !== true) return { body: await res.json() };
  return readLenientBody(res);
}

// Sends a request and answers { ok, status, headers, body, errorBody, detail } without ever throwing; `lenient` accepts a 2xx that is empty or not JSON and adds its raw `text`.
export async function requestJson(fetchImpl, url, { method = "GET", headers = {}, body, timeoutMs = 5000, signal, lenient = false } = {}) {
  try {
    const res = await fetchImpl(url, requestOptions({ method, headers, body, timeoutMs, signal }));
    const status = res.status;
    if (status < 200 || status >= 300) return { ok: false, status, headers: res.headers, body: null, errorBody: await readErrorBody(res), detail: `HTTP ${status}` };
    return { ok: true, status, headers: res.headers, ...(await successBody(res, lenient)), detail: "ok" };
  } catch (err) {
    return { ok: false, status: null, headers: null, body: null, detail: failureDetail(err, timeoutMs) };
  }
}
