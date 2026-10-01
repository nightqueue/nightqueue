// The only HTTP path of the integrations: a failure answers a status or a fixed detail, never an error message, URL or header.

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

// Sends a request and answers { ok, status, headers, body, detail } without ever throwing.
export async function requestJson(fetchImpl, url, { method = "GET", headers = {}, body, timeoutMs = 5000, signal } = {}) {
  try {
    const res = await fetchImpl(url, requestOptions({ method, headers, body, timeoutMs, signal }));
    const status = res.status;
    if (status < 200 || status >= 300) return { ok: false, status, headers: res.headers, body: null, detail: `HTTP ${status}` };
    return { ok: true, status, headers: res.headers, body: await res.json(), detail: "ok" };
  } catch (err) {
    return { ok: false, status: null, headers: null, body: null, detail: failureDetail(err, timeoutMs) };
  }
}
