import { openStore } from "../store/open.mjs";

// The non-empty texts of a job row the operator wrote, its prompt then its current retry note, joined by a blank line; null when both are empty.
function promptOfRow(row) {
  const parts = [row?.prompt, row?.operator_note].filter((text) => typeof text === "string" && text.trim() !== "").map((text) => text.trim());
  return parts.length === 0 ? null : parts.join("\n\n");
}

// The job's own prompt and current operator note as one text, read from the store; null outside a job or when the row cannot be read, so nothing is cleared by it.
export async function jobPromptText(run, env) {
  if (run?.jobId === null || run?.jobId === undefined) return null;
  try {
    return promptOfRow(await openStore(env).jobs.getJob(run.jobId));
  } catch {
    return null;
  }
}
