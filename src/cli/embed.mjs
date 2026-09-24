import { UserError } from "../config/errors.mjs";
import { modelsDir } from "../config/paths.mjs";
import { decisionProbe } from "../memory/decisions.mjs";
import { EMBEDDING_MODEL_TAG, embedTexts, isModelCached, warmupModel } from "../memory/embedding.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { setupEmbedding } from "./install-steps.mjs";
import { makeReport } from "./report.mjs";

const BATCH_SIZE = 100;
const MAX_BATCHES = 200;

// Runs `nightqueue embed install`: puts the embedding library in its own prefix and downloads the weights.
async function runInstall(argv, ctx) {
  checkArgs(parseCommand(argv).positionals, { max: 0, usage: "nightqueue embed install" });
  await setupEmbedding(ctx, makeReport(ctx), { embedding: true });
}

// Text a lesson is embedded by: title plus prevention.
function lessonProbe(lesson) {
  return [lesson.title, lesson.prevention].filter(Boolean).join(" ");
}

const CORPORA = [
  {
    label: "lesson",
    pending: (store, spec) => store.lessons.lessonsMissingEmbedding(spec),
    fill: (store, spec) => store.lessons.setLessonEmbedding(spec),
    probe: lessonProbe,
  },
  {
    label: "decision",
    pending: (store, spec) => store.decisions.decisionsMissingEmbedding(spec),
    fill: (store, spec) => store.decisions.setDecisionEmbedding(spec),
    probe: decisionProbe,
  },
];

// Runs `nightqueue embed download`: the only command of the CLI that opens the network.
async function runDownload(argv, ctx) {
  checkArgs(parseCommand(argv).positionals, { max: 0, usage: "nightqueue embed download" });
  const result = await warmupModel({ allowDownload: true }, ctx.env);
  ctx.out(
    result.downloaded
      ? `downloaded model ${result.model} into ${result.modelDir}`
      : `model ${result.model} already cached in ${result.modelDir}`,
  );
}

// Embeds one batch of rows of a corpus and returns how many rows were filled.
async function fillBatch(rows, corpus, store, env) {
  const vectors = await embedTexts(rows.map(corpus.probe), env);
  let filled = 0;
  for (const [index, row] of rows.entries()) {
    if (!vectors[index]) continue;
    await corpus.fill(store, { id: row.id, vector: vectors[index], model: EMBEDDING_MODEL_TAG });
    filled += 1;
  }
  return filled;
}

// Fills the missing embeddings of one corpus, batch by batch, and returns how many rows were filled.
async function backfillCorpus(corpus, store, env) {
  let filled = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const pending = await corpus.pending(store, { model: EMBEDDING_MODEL_TAG, limit: BATCH_SIZE });
    if (!pending.length) break;
    const done = await fillBatch(pending, corpus, store, env);
    if (!done) break;
    filled += done;
  }
  return filled;
}

// Runs `nightqueue embed backfill`: computes the missing embeddings from the weights already on disk.
async function runBackfill(argv, ctx) {
  checkArgs(parseCommand(argv).positionals, { max: 0, usage: "nightqueue embed backfill" });
  if (!isModelCached(ctx.env)) {
    throw new UserError(`no model weight in ${modelsDir(ctx.env)}; run \`nightqueue embed download\` first`);
  }
  const store = openStore(ctx.env);
  for (const corpus of CORPORA) {
    ctx.out(`filled ${await backfillCorpus(corpus, store, ctx.env)} ${corpus.label} embeddings`);
  }
}

const SUBCOMMANDS = new Map([
  ["install", runInstall],
  ["download", runDownload],
  ["backfill", runBackfill],
]);

// Dispatches the subcommands of `nightqueue embed`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown embed subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
