// Renders a section of the injected block, or nothing when there is no row to show.
export function section(title, rows, format) {
  return rows.length ? `## ${title}\n${rows.map(format).join("\n")}` : "";
}

// Shortens a text to the given budget, marking that it was cut.
export function clip(text, max) {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  return source.length > max ? `${source.slice(0, max - 3)}...` : source;
}
