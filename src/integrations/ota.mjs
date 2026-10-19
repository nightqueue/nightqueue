const OTA_SHOWN = new Set(["done", "warning"]);
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const REASON_MAX = 100;
const SHORT_GROUP = 8;
const TAIL_LINES = 20;
const TAIL_WIDTH = 200;

// A text on one line, its runs of whitespace collapsed to one space.
export function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// A text cut to a number of characters, ending with an ellipsis when it was longer.
export function cutText(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

// The last non-empty lines of a command's output, without ANSI codes and each cut to a readable width.
export function outputTail(text, { lines = TAIL_LINES, width = TAIL_WIDTH } = {}) {
  return String(text ?? "")
    .replace(ANSI_RE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .map((line) => cutText(line, width));
}

// The OTA outcome of a close worth telling an origin or a log: a done or warning `result.ota`, or null.
export function otaOf(result) {
  const ota = result?.ota;
  if (!ota || typeof ota !== "object" || Array.isArray(ota)) return null;
  return OTA_SHOWN.has(ota.status) ? ota : null;
}

// Why an OTA publish failed, on one short line.
export function otaReason(ota) {
  const first = String(ota?.note ?? "").split("\n").find((line) => line.trim()) ?? "";
  return cutText(oneLine(first), REASON_MAX) || "no reason given";
}

// The short form of an update group id.
export function shortGroupId(id) {
  return String(id ?? "").slice(0, SHORT_GROUP);
}

// The value of the OTA field of a close embed: the branch and group, linked when there is a url, or the failure.
export function otaFieldValue(ota) {
  if (ota?.status === "warning") return `failed (${otaReason(ota)})`;
  const text = `${ota?.branch ?? "unknown branch"} · ${shortGroupId(ota?.groupId)}`;
  return typeof ota?.url === "string" && ota.url ? `[${text}](${ota.url})` : text;
}

// The OTA line a close comment ends with, or null when the close published nothing worth telling.
export function otaCommentLine(ota) {
  if (ota?.status === "warning") return `OTA failed: ${otaReason(ota)}`;
  if (ota?.status !== "done") return null;
  const published = `OTA published to ${ota.branch ?? "unknown branch"}`;
  return typeof ota.url === "string" && ota.url ? `${published} (${ota.url})` : published;
}

// A close comment followed by the OTA line of the close, or the comment alone when there is none.
export function withOtaLine(text, result) {
  const line = otaCommentLine(otaOf(result));
  return line ? `${text}\n\n${line}` : text;
}
