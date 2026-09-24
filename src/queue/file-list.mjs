// The one section of the pipeline the runtime can write by itself, because git already knows what the implementation touched.
export const FILE_LIST = "## Modified files";

// One path of a `## Modified files` list, with the bullet and the backticks the agent may have written around it; a line carrying inner whitespace is the prose an agent tends to leave in the section, never one of the paths it lists one per line.
export function pathOfLine(line) {
  const text = line.trim().replace(/^[-*]\s+/, "").replace(/^`+|`+$/g, "").trim();
  if (text.startsWith("#") || /\s/.test(text)) return "";
  return text;
}

// The paths the implementation artifact listed under `## Modified files`, which is the list this commit is allowed to stage.
export function listedFiles(text) {
  const after = text.split(FILE_LIST).slice(1).join(FILE_LIST);
  const body = after.split("\n## ")[0] ?? "";
  return body.split("\n").map(pathOfLine).filter(Boolean);
}

// The artifact's text without its HTML comments and fenced code blocks, where a header or a path is an example, never the list.
function proseOf(text) {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, "");
}

// The paths an implementation artifact records for the runtime's own bookkeeping, read from its prose only.
export function recordedFiles(text) {
  return typeof text === "string" ? listedFiles(proseOf(text)) : [];
}
