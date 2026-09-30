import { recordJobBlock, recordRunFields } from "../src/queue/run-state.mjs";

const [, , mode, projectId, slug, first, second] = process.argv;

// One write into a run's state.json from its own process: the job block (`block <jobId> <createdAt>`) or one run field (`set <name> <value>`).
function writeOnce() {
  if (mode === "block") {
    return recordJobBlock({ projectId, slug, block: { id: Number(first), ref: `J-${first}`, createdAt: second }, env: process.env });
  }
  if (mode === "set") return recordRunFields({ projectId, slug, fields: { [first]: second }, env: process.env });
  throw new Error(`unknown mode \`${mode}\`: expected block or set`);
}

try {
  process.stdout.write(`${JSON.stringify(writeOnce())}\n`);
} catch (err) {
  process.stderr.write(`JOB_BLOCK_WRITER_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
}
