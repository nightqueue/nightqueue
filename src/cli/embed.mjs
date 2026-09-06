import { UserError } from "../config/errors.mjs";
import { modelsDir } from "../config/paths.mjs";
import { EMBEDDING_MODEL_TAG, embedTexts, isModelCached, warmupModel } from "../memory/embedding.mjs";
import { lessonsMissingEmbedding, setLessonEmbedding } from "../memory/lessons.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const BATCH_SIZE = 100;
const MAX_BATCHES = 200;

// Text a lesson is embedded by: title plus prevention.
function lessonProbe(lesson) {
  return [lesson.title, lesson.prevention].filter(Boolean).join(" ");
}

// Runs `shift embed download`: the only command of the CLI that opens the network.
async function runDownload(argv, ctx) {
  checkArgs(parseCommand(argv).positionals, { max: 0, usage: "shift embed download" });
  const result = await warmupModel({ allowDownload: true }, ctx.env);
  ctx.out(
    result.downloaded
      ? `downloaded model ${result.model} into ${result.modelDir}`
      : `model ${result.model} already cached in ${result.modelDir}`,
  );
}

// Embeds one batch of lessons and returns how many rows were filled.
async function fillBatch(lessons, env) {
  const vectors = await embedTexts(lessons.map(lessonProbe), env);
  let filled = 0;
  lessons.forEach((lesson, index) => {
    if (!vectors[index]) return;
    setLessonEmbedding({ id: lesson.id, vector: vectors[index], model: EMBEDDING_MODEL_TAG }, env);
    filled += 1;
  });
  return filled;
}

// Runs `shift embed backfill`: computes the missing embeddings from the weights already on disk.
async function runBackfill(argv, ctx) {
  checkArgs(parseCommand(argv).positionals, { max: 0, usage: "shift embed backfill" });
  if (!isModelCached(ctx.env)) {
    throw new UserError(`no model weight in ${modelsDir(ctx.env)}; run \`shift embed download\` first`);
  }
  let filled = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const pending = lessonsMissingEmbedding({ model: EMBEDDING_MODEL_TAG, limit: BATCH_SIZE }, ctx.env);
    if (!pending.length) break;
    const done = await fillBatch(pending, ctx.env);
    if (!done) break;
    filled += done;
  }
  ctx.out(`filled ${filled} lesson embeddings`);
}

const SUBCOMMANDS = new Map([
  ["download", runDownload],
  ["backfill", runBackfill],
]);

// Dispatches the subcommands of `shift embed`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown embed subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
