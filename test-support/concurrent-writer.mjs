import { saveLesson } from "../src/memory/lessons.mjs";
import { logPipelineRun } from "../src/memory/runs.mjs";

const [, , mode, label, durationRaw] = process.argv;
const DEFAULT_DURATION_MS = 2000;

// Writes one lesson, numbered so the rows of the two writers never collide.
function writeLesson(seq) {
  saveLesson(
    {
      project: null,
      title: `concurrent ${label} #${seq}`,
      root_cause: "concurrency root cause",
      solution: "concurrency solution",
      prevention: "concurrency prevention",
      attempts: 1,
      target: "qa",
      model: null,
    },
    process.env,
  );
}

// Writes one pipeline run, which is the transactional write path of the memory.
function writeRun() {
  logPipelineRun(
    {
      project: null,
      slug: `concurrent-${label}`,
      tier: "simple",
      outcome: "no_commit",
      phases: [
        { phase: "coder", status: "ok" },
        { phase: "qa", status: "ok" },
      ],
    },
    process.env,
  );
}

// Loops the write of argv (`<lesson|run> <label> <durationMs>`) until the deadline and prints how many rows it wrote.
function main() {
  if (mode !== "lesson" && mode !== "run") throw new Error(`unknown mode: ${String(mode)}`);
  const deadline = Date.now() + (Number(durationRaw) || DEFAULT_DURATION_MS);
  let written = 0;
  while (Date.now() < deadline) {
    if (mode === "lesson") writeLesson(written);
    else writeRun();
    written += 1;
  }
  process.stdout.write(`${JSON.stringify({ written })}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`WRITER_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
}
