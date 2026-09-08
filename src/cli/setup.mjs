import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { configPath, homeDir, secretsPath, shimNames } from "../config/paths.mjs";
import { emptyConfig, emptySecrets } from "../config/schema.mjs";
import { ensureHome } from "../config/store.mjs";
import { claudeCommandLine, runClaude } from "../host/claude.mjs";
import { MCP_SERVER_NAME, mcpAddArgs, mcpRemoveArgs, readRegisteredServer, serverIsCurrent } from "../host/mcp.mjs";
import { hostManifestPath, hostPackageRoot } from "../host/paths.mjs";
import {
  marketplaceAddArgs,
  marketplaceIsCurrent,
  marketplaceRemoveArgs,
  pluginInstallArgs,
  pluginRef,
  pluginUninstallArgs,
  readInstalledPlugin,
  readKnownMarketplace,
} from "../host/plugin.mjs";
import {
  desiredHooks,
  mergeHooks,
  readHostSettings,
  removeHooks,
  spacedRootWarning,
  writeHostSettings,
} from "../host/settings.mjs";
import { checkArgs, flagChoice, parseCommand } from "./args.mjs";
import {
  removeInstalledDirs,
  removePathStep,
  removeShimStep,
  setupEmbedding,
  setupPath,
  setupRuntime,
  setupShim,
} from "./install-steps.mjs";
import { firstLine, makeReport } from "./report.mjs";

const MARKETPLACE_LABEL = "plugin marketplace";
const USAGE =
  "nightshift setup [--from <dir>] [--path|--no-path] [--embedding|--no-embedding] [--shortcuts|--no-shortcuts] [--remove [--purge]]";

// Flags every command that installs the host shares.
export const INSTALL_OPTIONS = {
  from: { type: "string" },
  path: { type: "boolean" },
  "no-path": { type: "boolean" },
  embedding: { type: "boolean" },
  "no-embedding": { type: "boolean" },
  shortcuts: { type: "boolean" },
  "no-shortcuts": { type: "boolean" },
};

// Installation choices of one call, each opposite pair reduced to a tri-state.
export function installOptions(values, usage) {
  return {
    from: values.from,
    path: flagChoice(values, "path", usage),
    embedding: flagChoice(values, "embedding", usage),
    shortcuts: flagChoice(values, "shortcuts", usage),
  };
}

// Calls the claude CLI through the injectable subprocess runner of the context.
function callClaude(ctx, args) {
  return runClaude(args, { env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
}

// Reports a step the claude CLI could not finish, printing the exact command to run by hand.
function degradeCall(ctx, report, label, args, result) {
  const reason = result.missing ? "claude CLI not found" : firstLine(result.stderr) || `exit ${result.status}`;
  report.degrade(label, reason, claudeCommandLine(args, ctx.env));
}

// Runs one claude call, returning whether the step may go on.
function runStep(ctx, report, label, args) {
  const result = callClaude(ctx, args);
  if (!result.ok) degradeCall(ctx, report, label, args, result);
  return result.ok;
}

// Creates one file of the configuration home only when it is not there yet.
function ensureFile({ path, create, label, detail, report }) {
  if (existsSync(path)) {
    report.step(label, "already present");
    return;
  }
  create();
  report.step(label, "created", detail);
}

// Creates the configuration home and its two files, without changing anything that already exists.
function setupHome(ctx, report) {
  const home = ensureHome(ctx.env);
  report.step("home", home.created ? "created" : "already present", `${home.path}, 0700`);
  const config = emptyConfig();
  ensureFile({
    path: configPath(ctx.env),
    create: () => ctx.saveConfig(config, ctx.env),
    label: "config.json",
    detail: `org \`${config.defaultOrg}\``,
    report,
  });
  ensureFile({
    path: secretsPath(ctx.env),
    create: () => ctx.saveSecrets(emptySecrets(), ctx.env),
    label: "secrets.json",
    detail: "0600",
    report,
  });
}

// Registers the MCP server at user scope, reading the current state from disk instead of asking the CLI.
function setupMcp(ctx, report) {
  const label = `mcp ${MCP_SERVER_NAME}`;
  const entry = readRegisteredServer(ctx.env);
  if (serverIsCurrent(entry, ctx.env)) {
    report.step(label, "already present");
    return;
  }
  if (entry && !runStep(ctx, report, label, mcpRemoveArgs())) return;
  if (!runStep(ctx, report, label, mcpAddArgs(ctx.env))) return;
  report.step(label, entry ? "updated" : "created");
}

// Warns when the runtime path carries a space, the only case where the unquoted hook command breaks.
function warnOnSpacedRoot(ctx) {
  const warning = spacedRootWarning(hostPackageRoot(ctx.env));
  if (warning) ctx.err(warning);
}

// Applies the hook entries to the host settings, writing only when something actually changed.
function applyHooks(ctx, report, { remove }) {
  const settings = readHostSettings(ctx.env);
  const before = structuredClone(settings.data);
  const steps = remove ? removeHooks(settings.data, ctx.env) : mergeHooks(settings.data, ctx.env);
  if (!isDeepStrictEqual(before, settings.data)) writeHostSettings(ctx.env, settings);
  if (!remove) warnOnSpacedRoot(ctx);
  for (const step of steps) report.step(`hook ${step.event}`, step.status);
}

// Registers the runtime as a local marketplace of the host.
function setupMarketplace(ctx, report) {
  const known = readKnownMarketplace(ctx.env);
  if (marketplaceIsCurrent(known, ctx.env)) {
    report.step(MARKETPLACE_LABEL, "already present");
    return true;
  }
  if (known && !runStep(ctx, report, MARKETPLACE_LABEL, marketplaceRemoveArgs())) return false;
  if (!runStep(ctx, report, MARKETPLACE_LABEL, marketplaceAddArgs(ctx.env))) return false;
  report.step(MARKETPLACE_LABEL, known ? "updated" : "created");
  return true;
}

// Installs the plugin shipped by the runtime at user scope.
function setupPlugin(ctx, report) {
  if (!existsSync(hostManifestPath(ctx.env))) {
    report.degrade(MARKETPLACE_LABEL, "no .claude-plugin/marketplace.json in the runtime");
    return;
  }
  if (!setupMarketplace(ctx, report)) return;
  const label = `plugin ${pluginRef()}`;
  const installed = readInstalledPlugin(ctx.env);
  if (installed.state === "installed") {
    report.step(label, "already present");
    return;
  }
  if (!runStep(ctx, report, label, pluginInstallArgs())) return;
  report.step(label, "created");
}

// Reports every step that would point at the runtime as skipped, the answer when there is no runtime to point them at.
function skipHostSteps(ctx, report, { shortcuts } = {}) {
  const reason = "runtime missing";
  for (const name of shimNames({ shortcuts })) report.step(`shim ${name}`, "skipped", reason);
  report.step(`mcp ${MCP_SERVER_NAME}`, "skipped", reason);
  for (const hook of desiredHooks(ctx.env)) report.step(`hook ${hook.event}`, "skipped", reason);
  report.step(MARKETPLACE_LABEL, "skipped", reason);
}

// The single gate of every write that points at the runtime - shims, MCP server, hooks and plugin: without a ready runtime, none of them runs.
export function registerHost(ctx, report, { ready, shortcuts } = {}) {
  if (ready === false) {
    skipHostSteps(ctx, report, { shortcuts });
    return;
  }
  setupShim(ctx, report, { shortcuts });
  setupMcp(ctx, report);
  applyHooks(ctx, report, { remove: false });
  setupPlugin(ctx, report);
}

// Unregisters the MCP server, leaving every other server of the host alone.
function removeMcp(ctx, report) {
  const label = `mcp ${MCP_SERVER_NAME}`;
  if (!readRegisteredServer(ctx.env)) {
    report.step(label, "not present");
    return;
  }
  if (!runStep(ctx, report, label, mcpRemoveArgs())) return;
  report.step(label, "removed");
}

// Uninstalls the plugin and forgets the marketplace of this package.
function removePlugin(ctx, report) {
  const label = `plugin ${pluginRef()}`;
  if (readInstalledPlugin(ctx.env).state !== "installed") report.step(label, "not present");
  else if (runStep(ctx, report, label, pluginUninstallArgs())) report.step(label, "removed");
  if (!readKnownMarketplace(ctx.env)) {
    report.step(MARKETPLACE_LABEL, "not present");
    return;
  }
  if (!runStep(ctx, report, MARKETPLACE_LABEL, marketplaceRemoveArgs())) return;
  report.step(MARKETPLACE_LABEL, "removed");
}

// Closes the run, pointing at the diagnosis when a step degraded; a degraded step is never an exit code.
export function finish(ctx, report) {
  if (report.count()) ctx.out(`setup finished with ${report.count()} step(s) degraded - run \`nightshift doctor\``);
  return 0;
}

// Installs everything the host needs to run nightshift, one idempotent step at a time.
export async function install(ctx, { embedding, path, from, shortcuts } = {}) {
  const report = makeReport(ctx);
  setupHome(ctx, report);
  const ready = setupRuntime(ctx, report, { from });
  registerHost(ctx, report, { ready, shortcuts });
  await setupPath(ctx, report, { path });
  await setupEmbedding(ctx, report, { embedding });
  return finish(ctx, report);
}

// Takes the registrations of this package out of the host, keeping the configuration home unless `--purge` says otherwise.
async function uninstall(ctx, { purge }) {
  const report = makeReport(ctx);
  removeMcp(ctx, report);
  applyHooks(ctx, report, { remove: true });
  removePlugin(ctx, report);
  removeShimStep(ctx, report);
  removePathStep(ctx, report);
  await removeInstalledDirs(ctx, report, { purge });
  if (purge !== true) ctx.out(`home: kept (${homeDir(ctx.env)})`);
  return finish(ctx, report);
}

// Runs `nightshift setup`: installs the runtime and registers it in the host, or removes both with `--remove`.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    ...INSTALL_OPTIONS,
    remove: { type: "boolean" },
    purge: { type: "boolean" },
  });
  checkArgs(positionals, { max: 0, usage: USAGE });
  if (values.remove === true) return await uninstall(ctx, { purge: values.purge === true });
  return await install(ctx, installOptions(values, USAGE));
}
