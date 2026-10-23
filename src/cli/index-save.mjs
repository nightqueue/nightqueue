import { StoreUnavailableError } from "../config/errors.mjs";
import { resolveProjectRef } from "../config/projects.mjs";
import { withMeasuredMtimes } from "../memory/index-paths.mjs";
import { resolveJobRun } from "../queue/job-run.mjs";
import { appendPendingWrite, PENDING_KEYS } from "../queue/pending-writes.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { openStore } from "../store/open.mjs";
import { parseExploreArtifact } from "./explore-artifact.mjs";

// The warnings of a parsed explore artifact: no libraries section, and each library line that is not `<lib>@<version>`.
function parseWarnings(parsed) {
  const missing = parsed.libsSection ? [] : ["no `## Third-party libraries` section; no lib was saved"];
  return [...missing, ...parsed.ignoredLibs.map((line) => `not a \`<lib>@<version>\` entry, skipped: ${line}`)];
}

// Queues an index save the unavailable database refused inside a job into the job's run; outside a job, or for any other failure, the error is raised as it came.
async function queueIndexSave(err, { repoRoot, parsed }, ctx) {
  const own = callerJobId(ctx.env);
  if (!(err instanceof StoreUnavailableError) || own === null) throw err;
  const run = await resolveJobRun(own, ctx.env);
  const at = new Date().toISOString();
  const payload = { projectId: run.projectId, repoRoot, files: withMeasuredMtimes(parsed.files, repoRoot), libs: parsed.libs };
  const entry = { key: PENDING_KEYS.indexSave(run.projectId, at), kind: "index_save", at, jobId: own, payload };
  const queued = appendPendingWrite({ projectId: run.projectId, slug: run.slug, entry, env: ctx.env });
  if (queued.status !== "queued") throw err;
  return { status: "queued", path: queued.path };
}

// Persists the `## File map` and the `## Third-party libraries` of an explore artifact's text into the project index, or queues it inside a job whose store is unavailable.
export async function saveIndexFromText({ text, project, repoRoot, ctx, warn = () => {} }) {
  const parsed = parseExploreArtifact(text);
  for (const line of parseWarnings(parsed)) warn(line);
  const store = openStore(ctx.env);
  try {
    const saved = await store.index.saveProjectIndex({
      projectId: (await resolveProjectRef(store, project))?.id ?? null,
      repoRoot,
      files: parsed.files,
      libs: parsed.libs,
    });
    return { status: "saved", files: saved.files, libs: saved.libs };
  } catch (err) {
    return await queueIndexSave(err, { repoRoot, parsed }, ctx);
  }
}
