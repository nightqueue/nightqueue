import { storeHomeConnection } from "../cli/connection.mjs";
import { assertHomeFree, completeConnection, hasConnection, requireType } from "../config/connections.mjs";
import { UserError } from "../config/errors.mjs";
import { loadSecrets, saveSecrets } from "../config/store.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";

const NAME = "linear";
const TYPE = "linear";
const MAX_KEY_CHARS = 512;
const TEST_TIMEOUT_MS = 5000;

// The API key of a connect body, trimmed; anything else is refused without echoing the value.
function apiKeyOf(body) {
  const raw = body?.api_key;
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key || key.length > MAX_KEY_CHARS) throw new UserError(`\`api_key\` expects a non-empty string of at most ${MAX_KEY_CHARS} characters`);
  return key;
}

// Reads the home's secrets and refuses when a Linear connection is already stored.
function freeSecrets(env) {
  const secrets = loadSecrets(env, { warn: () => {} });
  assertHomeFree(secrets, TYPE);
  if (hasConnection(secrets, NAME)) throw new UserError(`connection \`${NAME}\` already exists; remove it first`);
  return secrets;
}

// Asks Linear who the key belongs to, refusing a key Linear does not accept; nothing is saved then.
async function testedViewer(apiKey, fetchImpl) {
  const result = await requireType(TYPE).test({ type: TYPE, apiKey }, { fetchImpl, timeoutMs: TEST_TIMEOUT_MS });
  if (!result?.ok) throw new UserError(`Linear refused the key (${result?.detail ?? "no answer"}); nothing was saved`);
  return result.viewer ?? null;
}

// Connects the home to Linear from the studio: tests the key first, then stores it the way `connection add` does.
export async function connectLinear({ body, env, fetchImpl = globalThis.fetch }) {
  refuseHomeWriteInsideJob(env);
  const apiKey = apiKeyOf(body);
  freeSecrets(env);
  const viewer = await testedViewer(apiKey, fetchImpl);
  const secrets = freeSecrets(env);
  const derived = await completeConnection({ type: TYPE, secret: apiKey, fetchImpl });
  storeHomeConnection({ env, secrets, name: NAME, type: TYPE, secret: apiKey, derived, saveSecrets });
  return { connected: true, name: NAME, type: TYPE, viewer };
}
