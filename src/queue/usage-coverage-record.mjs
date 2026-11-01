import { isStateObject } from "./resume.mjs";

// The merge-review line of a run whose always-gate class `run check 03` cleared by quotes, or null when the state holds no such record.
export function coverageRecordLine(state) {
  const record = isStateObject(state) ? state.usageCoverageCleared : null;
  const quotes = Array.isArray(record?.quotes) ? record.quotes.filter((quote) => typeof quote === "string" && quote.trim() !== "") : [];
  if (quotes.length === 0) return null;
  return `data access changed, covered by the quoted decisions: ${quotes.map((quote) => `"${quote}"`).join("; ")}`;
}
