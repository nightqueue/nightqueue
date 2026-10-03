export type MarkdownBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string };

export type InlinePart = { kind: "text" | "code" | "strong" | "em"; text: string };

const HEADING = /^#{1,6}\s+/;

const BULLET = /^\s*[-*+]\s+/;

const NUMBERED = /^\s*\d+[.)]\s+/;

const FENCE = /^\s*```/;

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/;

// The list marker a line opens with, null when it is no list item.
function listMarker(line: string): { ordered: boolean; marker: RegExp } | null {
  if (BULLET.test(line)) return { ordered: false, marker: BULLET };
  if (NUMBERED.test(line)) return { ordered: true, marker: NUMBERED };
  return null;
}

// Tells whether a line starts a block of its own rather than continuing a paragraph.
function opensBlock(line: string): boolean {
  return line.trim() === "" || HEADING.test(line) || FENCE.test(line) || listMarker(line) !== null;
}

// Reads a fenced code block from `start` (the fence line); answers the block and the index after it.
function readCode(lines: string[], start: number): [MarkdownBlock, number] {
  let end = start + 1;
  while (end < lines.length && !FENCE.test(lines[end])) end += 1;
  return [{ kind: "code", text: lines.slice(start + 1, end).join("\n") }, end + 1];
}

// Reads consecutive list items of one kind from `start`; answers the block and the index after it.
function readList(lines: string[], start: number, ordered: boolean): [MarkdownBlock, number] {
  const items: string[] = [];
  let index = start;
  while (index < lines.length && listMarker(lines[index])?.ordered === ordered) {
    items.push(lines[index].replace(ordered ? NUMBERED : BULLET, ""));
    index += 1;
  }
  return [{ kind: "list", ordered, items }, index];
}

// Reads a paragraph from `start` until a blank line or another block; answers the block and the index after it.
function readParagraph(lines: string[], start: number): [MarkdownBlock, number] {
  let end = start + 1;
  while (end < lines.length && !opensBlock(lines[end])) end += 1;
  return [{ kind: "paragraph", text: lines.slice(start, end).map((line) => line.trim()).join(" ") }, end];
}

// Splits a markdown text into the few blocks a notice uses: headings, paragraphs, lists and fenced code.
export function markdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const list = listMarker(line);
    let read: [MarkdownBlock, number] | null = null;
    if (line.trim() === "") index += 1;
    else if (FENCE.test(line)) read = readCode(lines, index);
    else if (HEADING.test(line)) read = [{ kind: "heading", text: line.replace(HEADING, "").trim() }, index + 1];
    else if (list) read = readList(lines, index, list.ordered);
    else read = readParagraph(lines, index);
    if (read) {
      blocks.push(read[0]);
      index = read[1];
    }
  }
  return blocks;
}

// Splits one line of markdown into plain text, `code`, **strong** and *em* parts.
export function inlineParts(text: string): InlinePart[] {
  return text
    .split(INLINE)
    .filter((part) => part !== "")
    .map((part): InlinePart => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return { kind: "code", text: part.slice(1, -1) };
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return { kind: "strong", text: part.slice(2, -2) };
      if (part.length > 2 && /^([*_]).*\1$/.test(part)) return { kind: "em", text: part.slice(1, -1) };
      return { kind: "text", text: part };
    });
}

// One line of markdown with its leading heading marker (`## `) removed, for a plain-text caption.
export function withoutHeadingMarker(line: string): string {
  return line.replace(/^\s*#{1,6}\s+/, "");
}
