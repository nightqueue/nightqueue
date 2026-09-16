import { isControlLine } from "../queue/stream.mjs";

const HEADING_LINE_RE = /^\s*#{1,6}(?:\s|$)/;

// Tells whether a line would forge a structural marker of the prompt: a markdown heading or a control literal the runtime parses.
function isForgedMarker(line) {
  return HEADING_LINE_RE.test(line) || isControlLine(line);
}

// Escapes one line so it stops reading as a structural marker, keeping every word the operator wrote.
function escapeMarkerLine(line) {
  const indent = /^\s*/.exec(line)[0];
  return `${indent}\\${line.slice(indent.length)}`;
}

// Neutralizes operator-authored free text, so it can never forge a heading of the prompt nor a literal of the runtime contract.
export function escapePromptMarkers(text) {
  const source = typeof text === "string" ? text : "";
  return source
    .split("\n")
    .map((line) => (isForgedMarker(line) ? escapeMarkerLine(line) : line))
    .join("\n");
}
