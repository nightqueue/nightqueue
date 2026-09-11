import { UserError } from "../config/errors.mjs";
import { modelsDir } from "../config/paths.mjs";
import { decisionsMissingEmbedding, setDecisionEmbedding } from "../memory/decisions.mjs";
import { EMBEDDING_MODEL_TAG, embedTexts, isModelCached, warmupModel } from "../memory/embedding.mjs";
import { lessonsMissingEmbedding, setLessonEmbedding } from "../memory/lessons.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { setupEmbedding } from "./install-steps.mjs";
import { makeReport } from "./report.mjs";

const BATCH_SIZE = 100;
const MAX_BATCHES = 200;

// Runs `nightshift embed install`: puts the embedding library in its own prefix and downloads the weights.
async function runInstall(argv, ctx) {
  checkArgs(parseCommand(argv).positionals, { max: 0, usage: "nightshift embed install" });
  await setupEmbedding(ctx, makeReport(ctx), { embedding: true });
}

// Text a lesson is embedded by: title plus prevention.
function lessonProbe(lesson) {
  return [lesson.title, lesson.prevention].filter(Boolean).join(" ");
}

// Text a decision is embedded by: title plus the decision itself.
function decisionProbe(decision) {
  return [decision.title, decision.decision].filter(Boolean).join(" ");
}

const CORPORA = [
  { label: "lesson", pending: lessonsMissingEmbedding, store: setLessonEmbedding, probe: lessonProbe },
  { label: "decision", pending: decisionsMissingEmbedding, store: setDecisionEmbedding, probe: decisionProbe },
];

// Runs `nightshift embed download`: the only command of the CLI that opens the network.
async function runDownload(argv, ctx) {
  checkArgs(parseCommand(argv).positionals, { max: 0, usage: "nightshift embed download" });
  const result = await warmupModel({ allowDownload: true }, ctx.env);
  ctx.out(
    result.downloaded
      ? `downloaded model ${result.model} into ${result.modelDir}`
      : `model ${result.model} already cached in ${result.modelDir}`,
  );
}

// Embeds one batch of rows of a corpus and returns how many rows were filled.
async function fillBatch(rows, corpus, env) {
  const vectors = await embedTexts(rows.map(corpus.probe), env);
  let filled = 0;
  rows.forEach((row, index) => {
    if (!vectors[index]) return;
    corpus.store({ id: row.id, vector: vectors[index], model: EMBEDDING_MODEL_TAG }, env);
    filled += 1;
  });
  return filled;
}

// Fills the missing embeddings of one corpus, batch by batch, and returns how many rows were filled.
async function backfillCorpus(corpus, env) {
  let filled = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const pending = corpus.pending({ model: EMBEDDING_MODEL_TAG, limit: BATCH_SIZE }, env);
    if (!pending.length) break;
    const done = await fillBatch(pending, corpus, env);
    if (!done) break;
    filled += done;
  }
  return filled;
}

// Runs `nightshift embed backfill`: computes the missing embeddings from the weights already on disk.
async function runBackfill(argv, ctx) {
  checkArgs(parseCommand(argv).positionals, { max: 0, usage: "nightshift embed backfill" });
  if (!isModelCached(ctx.env)) {
    throw new UserError(`no model weight in ${modelsDir(ctx.env)}; run \`nightshift embed download\` first`);
  }
  for (const corpus of CORPORA) {
    ctx.out(`filled ${await backfillCorpus(corpus, ctx.env)} ${corpus.label} embeddings`);
  }
}

const SUBCOMMANDS = new Map([
  ["install", runInstall],
  ["download", runDownload],
  ["backfill", runBackfill],
]);

// Dispatches the subcommands of `nightshift embed`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown embed subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
