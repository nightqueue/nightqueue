import { ghAuthStatus } from "../host/gh.mjs";

// The one line that tells how every job reaches GitHub, from what the machine's GitHub CLI reports.
function ghStatusLine(status) {
  if (status.missing) return "GitHub CLI not found; install it (https://cli.github.com)";
  if (status.authenticated === null) return "GitHub CLI status unavailable: `gh auth status` did not answer in time";
  if (!status.authenticated) return "GitHub CLI is not authenticated; run `gh auth login`";
  const host = status.host ? ` on ${status.host}` : "";
  return `GitHub: gh is authenticated as ${status.login ?? "an unknown account"}${host}; every job uses it`;
}

// Prints whether the machine's GitHub CLI is ready for the jobs; never stores anything, never prints a token, never throws.
export function reportGhStatus(ctx, { mode } = {}) {
  if (mode === "never") return;
  try {
    ctx.out(ghStatusLine(ghAuthStatus({ env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl })));
  } catch (err) {
    ctx.err(`GitHub CLI status not read: ${err?.message ?? String(err)}`);
  }
}
