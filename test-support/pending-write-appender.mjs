import { appendPendingWrite } from "../src/queue/pending-writes.mjs";

// Child process of the pending-writes tests: appends `count` telemetry entries keyed `<prefix>:<n>` to one run, printing every answer as JSON.
function main([projectId, slug, prefix, count]) {
  const answers = [];
  for (let n = 0; n < Number(count); n += 1) {
    const entry = { key: `${prefix}:${n}`, kind: "telemetry", jobId: null, payload: { projectId, slug: "no-such-run", durationS: 1, phases: [] } };
    answers.push(appendPendingWrite({ projectId, slug, entry, env: process.env }));
  }
  process.stdout.write(JSON.stringify(answers));
}

main(process.argv.slice(2));
