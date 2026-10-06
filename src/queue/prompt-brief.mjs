const BRIEF_HEADING = /^## Brief\b/;
const FENCE = /^(```|~~~)/;

// The `[index, line]` pairs of the prompt that sit outside a fenced code block.
function unfencedEntries(lines) {
  let fenced = false;
  const entries = [];
  for (const [index, line] of lines.entries()) {
    if (FENCE.test(line.trimStart())) fenced = !fenced;
    else if (!fenced) entries.push([index, line]);
  }
  return entries;
}

// Index of the first heading line after the `## Brief` one outside a fenced block, the end of the prompt when none follows, or -1 without a brief.
function briefEnd(lines) {
  let brief = -1;
  for (const [index, line] of unfencedEntries(lines)) {
    if (brief < 0 && BRIEF_HEADING.test(line)) brief = index;
    else if (brief >= 0 && line.startsWith("## ")) return index;
  }
  return brief < 0 ? -1 : lines.length;
}

// The text of the `## Brief` section of a prompt, found outside any fenced block, or null when the prompt carries none.
export function briefBody(prompt) {
  const lines = String(prompt ?? "").split("\n");
  const end = briefEnd(lines);
  if (end < 0) return null;
  const start = unfencedEntries(lines).find(([, line]) => BRIEF_HEADING.test(line))[0];
  return lines.slice(start + 1, end).join("\n");
}
