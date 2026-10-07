export type MarkdownBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

export type InlinePart = { kind: "text" | "code" | "strong" | "em"; text: string } | { kind: "link"; text: string; href: string };

export interface MarkdownOptions {
  rich?: boolean;
}

const SEPARATOR_CELL = /^:?-+:?$/;

const CELL_DIVIDER = /(?<!\\)\|/;

const LINK = /\[([^[\]\n]{1,1000})\]\((https?:\/\/[^\s)]{1,2048})\)/g;

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

// Reads a paragraph from `start` until a blank line or another block (a table too in rich mode); answers the block and the index after it.
function readParagraph(lines: string[], start: number, rich = false): [MarkdownBlock, number] {
  let end = start + 1;
  while (end < lines.length && !opensBlock(lines[end]) && !(rich && tableStartsAt(lines, end))) end += 1;
  return [{ kind: "paragraph", text: lines.slice(start, end).map((line) => line.trim()).join(" ") }, end];
}

// The cells of one pipe-table row: outer pipes dropped, split on unescaped pipes, `\|` kept as a pipe, each cell trimmed.
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(CELL_DIVIDER).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

// Tells whether a line is a table separator row: every cell dashes with optional alignment colons, in linear time.
function isSeparatorRow(line: string): boolean {
  return splitRow(line).every((cell) => SEPARATOR_CELL.test(cell));
}

// Tells whether a GFM pipe table starts at `index`: a row with a pipe, then a separator row with the same cell count.
function tableStartsAt(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  if (separator === undefined || !header.includes("|") || !isSeparatorRow(separator)) return false;
  return splitRow(header).length === splitRow(separator).length;
}

// One body row fitted to the header's width: padded with empty cells or cut.
function fitRow(cells: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => cells[index] ?? "");
}

// Reads a pipe table from `start` (its header row); answers the block and the index after it.
function readTable(lines: string[], start: number): [MarkdownBlock, number] {
  const header = splitRow(lines[start]);
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes("|") && !opensBlock(lines[index])) {
    rows.push(fitRow(splitRow(lines[index]), header.length));
    index += 1;
  }
  return [{ kind: "table", header, rows }, index];
}

// Splits a markdown text into the few blocks a notice uses: headings, paragraphs, lists and fenced code; pipe tables too in rich mode.
export function markdownBlocks(source: string, { rich = false }: MarkdownOptions = {}): MarkdownBlock[] {
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
    else if (rich && tableStartsAt(lines, index)) read = readTable(lines, index);
    else read = readParagraph(lines, index, rich);
    if (read) {
      blocks.push(read[0]);
      index = read[1];
    }
  }
  return blocks;
}

// The http(s) URL of a link target, null for any other scheme or an unparsable one.
function webHref(href: string): string | null {
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

// Splits one plain text part around its `[text](http(s)://…)` links; any other link stays literal text.
function linkParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let from = 0;
  for (const match of text.matchAll(LINK)) {
    const href = webHref(match[2]);
    const at = match.index ?? 0;
    if (href === null) continue;
    if (at > from) parts.push({ kind: "text", text: text.slice(from, at) });
    parts.push({ kind: "link", text: match[1], href });
    from = at + match[0].length;
  }
  if (from < text.length) parts.push({ kind: "text", text: text.slice(from) });
  return parts;
}

// Splits one line of markdown into plain text, `code`, **strong** and *em* parts; http(s) links too in rich mode.
export function inlineParts(text: string, { rich = false }: MarkdownOptions = {}): InlinePart[] {
  const parts = plainInlineParts(text);
  return rich ? parts.flatMap((part) => (part.kind === "text" ? linkParts(part.text) : [part])) : parts;
}

// Splits one line of markdown into plain text, `code`, **strong** and *em* parts.
function plainInlineParts(text: string): InlinePart[] {
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
