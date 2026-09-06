import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { modelsDir } from "../config/paths.mjs";

export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DTYPE = "q8";
export const EMBEDDING_DIMS = 384;
export const EMBEDDING_MODEL_TAG = `${EMBEDDING_MODEL_ID}@${EMBEDDING_DTYPE}`;

const pipelines = new Map();

// Path of the quantized weight inside the local cache.
function modelWeightPath(env) {
  return join(modelsDir(env), EMBEDDING_MODEL_ID, "onnx", "model_quantized.onnx");
}

// Tells whether the quantized weight is already on disk; for human messages only, never a runtime gate.
export function isModelCached(env = process.env) {
  return existsSync(modelWeightPath(env));
}

// Instantiates the extractor with the weight cache pinned outside node_modules; the network only opens when allowDownload is true.
async function createPipeline(allowDownload, env) {
  const dir = modelsDir(env);
  if (allowDownload) mkdirSync(dir, { recursive: true });
  const { pipeline, env: libEnv } = await import("@huggingface/transformers");
  libEnv.cacheDir = dir;
  libEnv.localModelPath = dir;
  libEnv.useFSCache = true;
  libEnv.allowLocalModels = true;
  libEnv.allowRemoteModels = allowDownload === true;
  return await pipeline("feature-extraction", EMBEDDING_MODEL_ID, { dtype: EMBEDDING_DTYPE });
}

// Single load per weight cache holding the PROMISE, so concurrent calls share it; a rejection clears the entry.
function loadPipeline({ allowDownload = false } = {}, env = process.env) {
  const key = modelsDir(env);
  const cached = pipelines.get(key);
  if (cached) return cached;
  const promise = createPipeline(allowDownload, env).catch((err) => {
    pipelines.delete(key);
    throw err;
  });
  pipelines.set(key, promise);
  return promise;
}

// L2-normalized vectors of a list of texts.
export async function embedTexts(texts, env = process.env) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return [];
  const extractor = await loadPipeline({}, env);
  const vectors = [];
  for (const text of list) {
    const source = String(text ?? "").trim();
    if (!source) throw new Error("embedding: an empty text cannot become a vector");
    const tensor = await extractor(source, { pooling: "mean", normalize: true });
    vectors.push(Float32Array.from(tensor.data));
  }
  return vectors;
}

// L2-normalized vector of one text.
export async function embedText(text, env = process.env) {
  const [vector] = await embedTexts([text], env);
  return vector;
}

// Turns a missing optional dependency into an actionable message, keeping any other failure as is.
function explainMissingLibrary(err) {
  const message = String(err?.message ?? "");
  if (err?.code !== "ERR_MODULE_NOT_FOUND" && !message.includes("@huggingface/transformers")) return err;
  return new UserError(
    "optional dependency @huggingface/transformers is not installed; run npm install to enable the semantic recall",
  );
}

// The only authorized network path: warms the weight cache and confirms it with a probe inference.
export async function warmupModel({ allowDownload = false } = {}, env = process.env) {
  const cachedBefore = isModelCached(env);
  try {
    await loadPipeline({ allowDownload }, env);
    const vector = await embedText("embedding model warmup probe", env);
    if (vector?.length !== EMBEDDING_DIMS) {
      throw new Error(`embedding: model returned ${vector?.length ?? 0} dims (expected ${EMBEDDING_DIMS})`);
    }
  } catch (err) {
    throw explainMissingLibrary(err);
  }
  return { model: EMBEDDING_MODEL_TAG, modelDir: modelsDir(env), downloaded: !cachedBefore };
}
