import { closeLastCell } from "./close-view.mjs";
import { parkedJobLabel } from "./hints.mjs";
import { agentGlyph } from "./routing.mjs";

// The four token counters of a job: the live estimate while it runs and has one, the recorded columns otherwise.
export function tokenCountersOf(job) {
  const live = job.status === "running" ? job.live?.tokens : null;
  if (live) return [live.in, live.out, live.cache_read, live.cache_creation];
  return [job.tokens_in, job.tokens_out, job.cache_read, job.cache_creation];
}

// A token total, compact: `374k`, `1.2M`, `~` in front when estimated, `-` when nothing was spent or the total is not a number.
export function compactTokens(total, { estimated = false } = {}) {
  if (!Number.isFinite(total) || total <= 0) return "-";
  const mark = estimated ? "~" : "";
  if (total < 1000) return `${mark}${total}`;
  if (total < 1_000_000) return `${mark}${Math.round(total / 1000)}k`;
  return `${mark}${(total / 1_000_000).toFixed(1)}M`;
}

// Tokens the job spent, cache included, compact: `374k`, `1.2M`, `~66.9M` while estimated, `-` before the first usage report.
export function formatTokens(job) {
  const total = tokenCountersOf(job).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const estimated = job.status === "running" && Boolean(job.live?.tokens) && job.live.tokens_estimated === true;
  return compactTokens(total, { estimated });
}

// What a running job is doing as the table says it: the agent glyph, its intent, then the last action; a job without a readable log shows `-`.
export function liveCell(live) {
  if (!live) return "-";
  const glyph = agentGlyph(live.agent) ?? "»";
  const parts = [live.intent, live.last?.text].filter((part, index, all) => part && all.indexOf(part) === index);
  return parts.length ? `${glyph} ${parts.join(" — ")}` : "-";
}

// First line of the notice of a job, the reason it stopped, for the table.
export function firstNoticeLine(job) {
  const line = String(job.notice_md ?? "").split("\n").find((entry) => entry.trim());
  return line ? line.trim() : null;
}

// The human message of a block, read from the JSON result only while it still names the same code the column carries;
// a truncated or stale result never breaks the render, it just leaves the message out.
export function blockedMessage(job, code) {
  try {
    const parsed = typeof job.result === "string" ? JSON.parse(job.result) : job.result;
    const blocked = parsed?.blocked;
    return blocked?.code === code ? String(blocked.message ?? "") : "";
  } catch {
    return "";
  }
}

// The preflight block a gated job carries in its `blocked_code` column, or null: the reason the runner did not start it.
export function blockedOf(job) {
  if (job.status !== "gate" || !job.blocked_code) return null;
  const code = String(job.blocked_code);
  return { code, message: blockedMessage(job, code) };
}

// Why a job that is not running stands where it does (close note, preflight block, gate notice, parked reset), or null.
export function stoppedReason(job) {
  const close = closeLastCell(job);
  if (close) return close;
  const blocked = blockedOf(job);
  if (blocked) return blocked.message ? `⛔ ${blocked.code}: ${blocked.message}` : `⛔ ${blocked.code}`;
  if (job.status === "gate" || job.status === "failed") return firstNoticeLine(job);
  return parkedJobLabel(job);
}

// What TITLE/LAST says about a job: the live view while it runs, otherwise its title followed by the reason above.
export function lastCell(job) {
  if (job.status === "running") return liveCell(job.live);
  return [job.title, stoppedReason(job)].filter(Boolean).join(" — ") || "-";
}
