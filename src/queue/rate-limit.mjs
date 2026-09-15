import { readFileSync } from "node:fs";
import { queueResumePath } from "../config/paths.mjs";
import { listRunnerRecords, mergeOwnRunnerRecord, ownRunnerRecord, updateOwnRunnerRecord } from "./registry.mjs";

// Utilization of the FIVE-HOUR window from which a warning is already worth waiting out; the seven-day one is reported and never acted on.
export const WARNING_UTILIZATION = 0.95;
// Slack added to the reset the provider announced, so a runner never wakes a second too early.
export const PAUSE_GRACE_S = 60;
// Longest slice of a pause a runner sleeps in one go, so a shutdown signal or a resume is noticed while it waits.
export const PAUSE_POLL_MS = 15000;

// The window a rate limit type names, or null when the event carries no such window.
function namedWindow(info, type) {
  if (type === "five_hour") return info.fiveHour;
  if (type === "seven_day") return info.sevenDay;
  return null;
}

// What a rejection waits for: the limit the event itself names, on any window, until its own top-level reset -
// and, when that reset carried no magnitude the parser could read, until the reset the named window announced.
function rejectedWindow(info) {
  const window = namedWindow(info, info.type);
  return { type: info.type, resetsAt: info.resetsAt ?? window?.resetsAt ?? null, utilization: window?.utilization ?? null };
}

// What a warning waits for: only a five-hour budget at the threshold, because the seven-day one resets days away and pauses nothing.
function warningWindow(info) {
  const window = info.fiveHour;
  if (!Number.isFinite(window?.utilization) || window.utilization < WARNING_UTILIZATION) return null;
  return { type: "five_hour", resetsAt: window.resetsAt, utilization: window.utilization };
}

// The window an event arms a pause on, read by exact equality on `status` and nothing else.
function armedWindow(info) {
  if (info?.status === "rejected") return rejectedWindow(info);
  if (info?.status === "allowed_warning") return warningWindow(info);
  return null;
}

// The pause a rate limit event arms, or null when it arms none: an event without a usable reset never pauses anything.
export function pauseFromEvent(info, now = Date.now()) {
  const armed = armedWindow(info);
  if (!armed || !Number.isFinite(armed.resetsAt)) return null;
  return {
    pausedAt: new Date(now).toISOString(),
    pausedUntil: new Date(armed.resetsAt + PAUSE_GRACE_S * 1000).toISOString(),
    resetsAt: new Date(armed.resetsAt).toISOString(),
    type: armed.type,
    utilization: armed.utilization,
  };
}

// The instant a pause still runs until, in milliseconds; a pause already over, absent or malformed is null.
export function pauseUntilMs(pause, now = Date.now()) {
  const until = Date.parse(String(pause?.pausedUntil ?? ""));
  return Number.isFinite(until) && until > now ? until : null;
}

// The pause THIS runner armed for itself, as its own registration carries it; a process with no record has none.
export function readOwnPause(env = process.env) {
  const pause = ownRunnerRecord(env)?.rateLimit;
  return pause && typeof pause === "object" ? pause : null;
}

// The instant this runner's own pause runs until, the seam the spawn polls while the child waits the limit out.
export function ownPauseUntilMs(env = process.env, now = Date.now()) {
  return pauseUntilMs(readOwnPause(env), now);
}

// Writes the pause into the registration of THIS runner, the only file a runner ever writes its own transient state into.
export async function recordOwnPause(pause, env = process.env) {
  return await mergeOwnRunnerRecord({ rateLimit: pause }, env);
}

// Tells whether two records of a pause are the same one: the instant it was armed at and the instant it runs until.
function samePause(left, right) {
  return String(left?.pausedAt) === String(right?.pausedAt) && String(left?.pausedUntil) === String(right?.pausedUntil);
}

// Removes the pause region of THIS runner when the record inside the lock still answers the decision the clear was taken from.
async function dropOwnPause(decided, env) {
  return await updateOwnRunnerRecord((info) => (decided(info.rateLimit) ? { rateLimit: null } : null), env);
}

// Clears the pause of THIS runner, and only the pause the clear was decided from: the region is compared inside the lock
// before it is removed whole, so a decision taken from a stale read never wipes limit information newer than itself.
export async function clearOwnPause(env, decidedFrom) {
  if (decidedFrom === null || decidedFrom === undefined) {
    throw new TypeError("clearOwnPause needs the pause the clear was decided from; call clearOwnPauseIfOver(env) to drop a pause that no longer holds");
  }
  return await dropOwnPause((onRecord) => samePause(onRecord, decidedFrom), env);
}

// Clears the pause of THIS runner only while it no longer holds, the decision re-taken inside the lock: a pause a
// concurrent job armed or extended since the caller read it still holds there, and survives.
export async function clearOwnPauseIfOver(env = process.env) {
  return await dropOwnPause((onRecord) => pauseUntilMs(onRecord) === null, env);
}

// The pause carried by one registration, or null when it carries none that still runs.
function livePauseOf(record) {
  const pause = record.info?.rateLimit;
  if (!pause || typeof pause !== "object") return null;
  return pauseUntilMs(pause) === null ? null : pause;
}

// The pause a runner starting now inherits: the furthest-future one among the live runners of this home, read once and never written back.
export function inheritablePause(env = process.env, killImpl = undefined) {
  const pauses = listRunnerRecords(env, killImpl)
    .filter((record) => record.status === "alive")
    .map(livePauseOf)
    .filter(Boolean);
  if (!pauses.length) return null;
  return pauses.reduce((furthest, pause) => (pauseUntilMs(pause) > pauseUntilMs(furthest) ? pause : furthest));
}

// The instant the operator last asked every runner of this home to resume, or null when they never did.
export function resumeRequestedAt(env = process.env) {
  try {
    const stamp = Date.parse(readFileSync(queueResumePath(env), "utf8").trim());
    return Number.isFinite(stamp) ? stamp : null;
  } catch {
    return null;
  }
}
