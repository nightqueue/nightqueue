import { requestJson } from "./http.mjs";

const GITHUB_API = "https://api.github.com";

// Converts the GitHub API answer into the connection test result.
function githubResult(answer) {
  if (!answer.ok) return { ok: false, status: answer.status, login: null, scopes: null, detail: answer.detail };
  return {
    ok: true,
    status: answer.status,
    login: answer.body?.login ?? null,
    scopes: answer.headers?.get?.("x-oauth-scopes") ?? null,
    detail: "ok",
  };
}

// Validates the token of a GitHub connection, without exposing the value in the result.
async function testGithub(secret, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const answer = await requestJson(fetchImpl, `${GITHUB_API}/user`, {
    headers: { Authorization: `Bearer ${secret.token}`, Accept: "application/vnd.github+json" },
    timeoutMs,
  });
  return githubResult(answer);
}

// Describes a successful GitHub connection test in one line.
function summarizeGithub(result) {
  return `login=${result.login ?? "(none)"} scopes=${result.scopes || "(none)"}`;
}

export const github = {
  kind: "github",
  connection: {
    cardinality: "one",
    secretFields: ["token"],
    extraFields: [],
    secretLabel: "secret",
    test: testGithub,
    summary: summarizeGithub,
  },
};
