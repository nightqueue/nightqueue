import type { DiffHunk, DiffLine } from "./types";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface OpenHunk {
  hunk: DiffHunk;
  oldNo: number;
  newNo: number;
  oldLeft: number;
  newLeft: number;
}

// A count of a hunk header, 1 when git omitted it.
function countOf(raw: string | undefined): number {
  return raw === undefined ? 1 : Number(raw);
}

// The open hunk a `@@` header starts, null when the line is not one.
function hunkStart(line: string): OpenHunk | null {
  const match = HUNK_HEADER.exec(line);
  if (!match) return null;
  return {
    hunk: { header: line, lines: [] },
    oldNo: Number(match[1]),
    newNo: Number(match[3]),
    oldLeft: countOf(match[2]),
    newLeft: countOf(match[4]),
  };
}

// The numbered line one row of a hunk is, moving the hunk's counters past it.
function hunkLine(open: OpenHunk, line: string): DiffLine {
  const marker = line[0];
  const text = line.slice(1);
  if (marker === "+") {
    open.newLeft -= 1;
    return { kind: "add", text, oldNo: null, newNo: open.newNo++ };
  }
  if (marker === "-") {
    open.oldLeft -= 1;
    return { kind: "del", text, oldNo: open.oldNo++, newNo: null };
  }
  if (marker === "\\") return { kind: "meta", text: line, oldNo: null, newNo: null };
  open.oldLeft -= 1;
  open.newLeft -= 1;
  return { kind: "ctx", text, oldNo: open.oldNo++, newNo: open.newNo++ };
}

// Whether a hunk has read every line its header announced.
function isDone(open: OpenHunk): boolean {
  return open.oldLeft <= 0 && open.newLeft <= 0;
}

// The hunks of a unified diff with old/new line numbers, and whether git called the file binary.
export function parseUnifiedDiff(text: string | null | undefined): { hunks: DiffHunk[]; binary: boolean } {
  const hunks: DiffHunk[] = [];
  let binary = false;
  let open: OpenHunk | null = null;
  for (const line of typeof text === "string" ? text.split("\n") : []) {
    if (open && !isDone(open)) {
      open.hunk.lines.push(hunkLine(open, line));
      continue;
    }
    if (open && line.startsWith("\\")) {
      open.hunk.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }
    open = hunkStart(line);
    if (open) hunks.push(open.hunk);
    else if (line.startsWith("Binary files ")) binary = true;
  }
  return { hunks, binary };
}
