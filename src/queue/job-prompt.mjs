import { openStore } from "../store/open.mjs";

// The non-empty texts of a job row the operator wrote, its prompt then its current retry note, joined by a blank line; null when both are empty.
function promptOfRow(row) {
  const parts = [row?.prompt, row?.operator_note].filter((text) => typeof text === "string" && text.trim() !== "").map((text) => text.trim());
  return parts.length === 0 ? null : parts.join("\n\n");
}

// The row of the run's job; null outside a job or when the row cannot be read, so nothing is decided by it.
async function jobRowOf(run, env) {
  if (run?.jobId === null || run?.jobId === undefined) return null;
  try {
    return await openStore(env).jobs.getJob(run.jobId);
  } catch {
    return null;
  }
}

// The job's own prompt and current operator note as one text, read from the store; null outside a job or when the row cannot be read.
export async function jobPromptText(run, env) {
  return promptOfRow(await jobRowOf(run, env));
}

// The job's current operator note, read from the store; null outside a job, without a note or when the row cannot be read.
export async function jobOperatorNote(run, env) {
  const note = (await jobRowOf(run, env))?.operator_note;
  return typeof note === "string" && note.trim() !== "" ? note.trim() : null;
}
