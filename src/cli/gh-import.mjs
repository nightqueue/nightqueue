import { addConnection, connectionFor, hasConnection, testConnection } from "../config/connections.mjs";
import { loadConfig, loadSecrets } from "../config/store.mjs";
import { ghAuthStatus, ghAuthToken } from "../host/gh.mjs";
import { saveConfigAfterSecret } from "./connection.mjs";
import { confirm } from "./prompt.mjs";

const NAME = "gh";
const TYPE = "github";

// Line that tells the operator how to store the token by hand, the fallback of every branch that imports nothing.
function manualHint() {
  return `store a token with \`echo "$GITHUB_TOKEN" | nightqueue connection add ${NAME} --type ${TYPE}\``;
}

// The question asked before touching the token, with the account the GitHub CLI reports.
function importQuestion(login) {
  return `GitHub CLI is authenticated as ${login ?? "an unknown account"} — import its token as connection "${NAME}"? [Y/n] `;
}

// Tells why the import cannot go on given what is already stored, or null when the slot is free.
function storedBlocker(config, secrets, org) {
  const occupiedBy = connectionFor(config, org, TYPE);
  if (occupiedBy) return `org \`${org}\` already uses \`${occupiedBy}\` for ${TYPE}; nothing to import`;
  if (hasConnection(secrets, NAME)) {
    return `connection \`${NAME}\` already exists; run \`nightqueue connection bind ${NAME} --org ${org}\``;
  }
  return null;
}

// Tells why the GitHub CLI cannot provide a token, or null when it is installed and authenticated.
function cliBlocker(status) {
  if (status.missing) return `GitHub CLI not found; ${manualHint()}`;
  if (!status.authenticated) return `GitHub CLI is not authenticated; run \`gh auth login\` and then \`nightqueue init --gh\``;
  return null;
}

// Decides whether the operator wants the import, asking only on a terminal and only when no flag already answered.
async function wantsImport(ctx, { mode, login }) {
  if (mode === "always") return true;
  if (!ctx.stdin?.isTTY) {
    ctx.out(`GitHub CLI is authenticated as ${login ?? "an unknown account"}; run \`nightqueue init --gh\` to import its token as connection \`${NAME}\``);
    return false;
  }
  return await confirm({ stdin: ctx.stdin, stdout: ctx.stdout, question: importQuestion(login) });
}

// Checks the connection that was just stored, reporting the result without ever failing the command around it.
async function reportTest(ctx, secrets) {
  try {
    const result = await testConnection({ name: NAME, secrets, fetchImpl: ctx.fetchImpl });
    if (result.ok) ctx.out(`${NAME} (${result.type}): ok — login=${result.login ?? "(none)"} scopes=${result.scopes || "(none)"}`);
    else ctx.err(`${NAME} (${result.type}): failed — ${result.detail}`);
  } catch (err) {
    ctx.err(`${NAME} (${TYPE}): failed — ${err?.message ?? String(err)}`);
  }
}

// Stores the token of the GitHub CLI as the `gh` connection of the org and checks it.
async function storeToken(ctx, { config, secrets, org }) {
  const read = ghAuthToken({ env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  if (!read.ok) {
    ctx.out(`could not read the token from the GitHub CLI; run \`gh auth login\``);
    return;
  }
  const result = addConnection({ config, secrets, name: NAME, type: TYPE, org, secret: read.token });
  ctx.saveSecrets(result.secrets, ctx.env);
  saveConfigAfterSecret({ config: result.config, ctx, name: NAME, org });
  ctx.out(`stored connection \`${NAME}\` (${TYPE}) and bound it to org \`${org}\``);
  await reportTest(ctx, result.secrets);
}

// Offers the token of the GitHub CLI as the `gh` connection of an org; never throws and never prints the token.
export async function importGhConnection(ctx, { mode, org } = {}) {
  if (mode === "never") return;
  const config = loadConfig(ctx.env, { warn: ctx.err });
  const secrets = loadSecrets(ctx.env, { warn: ctx.err });
  const stored = storedBlocker(config, secrets, org);
  if (stored) {
    ctx.out(stored);
    return;
  }
  const status = ghAuthStatus({ env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  const blocked = cliBlocker(status);
  if (blocked) {
    ctx.out(blocked);
    return;
  }
  if (!(await wantsImport(ctx, { mode, login: status.login }))) {
    if (ctx.stdin?.isTTY) ctx.out(manualHint());
    return;
  }
  await storeToken(ctx, { config, secrets, org });
}
