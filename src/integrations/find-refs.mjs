// Lists every reference a text carries, in text order: each rule is { pattern, ref } where ref turns a match into the reference.
export function refsInTextOrder(text, rules) {
  if (typeof text !== "string" || !text) return [];
  const found = [];
  for (const { pattern, ref } of rules) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(global)) found.push({ index: match.index, ref: ref(match) });
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.ref).filter((ref) => typeof ref === "string" && ref);
}
