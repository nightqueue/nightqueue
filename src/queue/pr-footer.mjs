import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobRef } from "../memory/refs.mjs";

export const PUBLISHED_BODY_FILE = "pr-body.published.md";

// The traceability footer `run pr` appends to every pull request body.
export const PR_FOOTER = "Opened by nightqueue";

// The `<kind> <ref>` part of one origin, or an empty text when either is missing.
function originPart(origin) {
  const kind = typeof origin?.kind === "string" ? origin.kind.trim() : "";
  const ref = typeof origin?.ref === "string" ? origin.ref.trim() : "";
  return kind && ref ? `${kind} ${ref}` : "";
}

// The footer line of a run: the plain footer, then the job's ref inside a job, then the kind and ref of every origin of the job in stored order.
export function footerLine({ jobId = null, origins = [] } = {}) {
  const parts = [PR_FOOTER];
  if (Number.isSafeInteger(jobId) && jobId > 0) parts.push(jobRef(jobId));
  const list = Array.isArray(origins) ? origins : [];
  for (const part of list.map(originPart)) if (part) parts.push(part);
  return parts.join(" · ");
}

// The body file `run pr` publishes: a copy of the agent's body in the run directory, then the runtime's coverage line when given, ending with the footer.
export function publishedBodyFile({ bodyFile, runDir, jobId, origins = [], coverageLine = null }) {
  try {
    const body = readFileSync(bodyFile, "utf8");
    mkdirSync(runDir, { recursive: true });
    const published = join(runDir, PUBLISHED_BODY_FILE);
    const coverage = typeof coverageLine === "string" && coverageLine.trim() ? `${coverageLine.trim()}\n\n` : "";
    writeFileSync(published, `${body.replace(/\s+$/, "")}\n\n${coverage}${footerLine({ jobId, origins })}\n`);
    return published;
  } catch (error) {
    const source = jobId === null || jobId === undefined ? "outside a job" : `from ${jobRef(jobId)}`;
    throw new UserError(`could not build the pull request footer ${source}: ${error?.message ?? String(error)}; nothing was pushed`);
  }
}
