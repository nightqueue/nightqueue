import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobRef } from "../memory/refs.mjs";

export const PUBLISHED_BODY_FILE = "pr-body.published.md";

// The traceability footer `run pr` appends to every pull request body.
export const PR_FOOTER = "Opened by nightqueue";

// The footer line of a job: the plain footer, naming the kind and ref of the job's origin when it has one.
export function footerLine(origin) {
  const kind = typeof origin?.kind === "string" ? origin.kind.trim() : "";
  const ref = typeof origin?.ref === "string" ? origin.ref.trim() : "";
  return kind && ref ? `${PR_FOOTER} · ${kind} ${ref}` : PR_FOOTER;
}

// The body file `run pr` publishes: a copy of the agent's body in the run directory ending with the footer.
export function publishedBodyFile({ bodyFile, runDir, jobId, origin = null }) {
  try {
    const body = readFileSync(bodyFile, "utf8");
    mkdirSync(runDir, { recursive: true });
    const published = join(runDir, PUBLISHED_BODY_FILE);
    writeFileSync(published, `${body.replace(/\s+$/, "")}\n\n${footerLine(origin)}\n`);
    return published;
  } catch (error) {
    const source = jobId === null || jobId === undefined ? "outside a job" : `from ${jobRef(jobId)}`;
    throw new UserError(`could not build the pull request footer ${source}: ${error?.message ?? String(error)}; nothing was pushed`);
  }
}
