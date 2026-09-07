import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { configPath, homeDir, secretsPath } from "../config/paths.mjs";
import { emptyConfig, emptySecrets } from "../config/schema.mjs";
import { ensureHome } from "../config/store.mjs";
import { claudeCommandLine, runClaude } from "../host/claude.mjs";
import { MCP_SERVER_NAME, mcpAddArgs, mcpRemoveArgs, readRegisteredServer, serverIsCurrent } from "../host/mcp.mjs";
import {
  marketplaceAddArgs,
  marketplaceIsCurrent,
  marketplaceRemoveArgs,
  pluginInstallArgs,
  pluginRef,
  pluginUninstallArgs,
  readInstalledPlugin,
  readKnownMarketplace,
  readManifest,
} from "../host/plugin.mjs";
import { mergeHooks, readHostSettings, removeHooks, spacedRootWarning, writeHostSettings } from "../host/settings.mjs";
import { warmupModel } from "../memory/embedding.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const MARKETPLACE_LABEL = "plugin marketplace";

// One line of the report, always `<label>: <status>` plus an optional detail.
function stepLine(label, status, detail) {
  return `${label}: ${status}${detail ? ` (${detail})` : ""}`;
}

// First line of a subprocess error, short enough to sit inside a report line.
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200);
}

// Reporter of the run: prints every step and counts the ones that could not be finished.
function makeReport(ctx) {
  let degraded = 0;
  return {
    step: (label, status, detail) => ctx.out(stepLine(label, status, detail)),
    degrade: (label, reason, command) => {
      degraded += 1;
      ctx.out(stepLine(label, "failed", reason));
      if (command) ctx.err(`shift: finish this step by hand: ${command}`);
    },
    count: () => degraded,
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
  if (serverIsCurrent(entry)) {
    report.step(label, "already present");
    return;
  }
  if (entry && !runStep(ctx, report, label, mcpRemoveArgs())) return;
  if (!runStep(ctx, report, label, mcpAddArgs())) return;
  report.step(label, entry ? "updated" : "created");
}

// Warns when the package path carries a space, the only case where the unquoted hook command breaks.
function warnOnSpacedRoot(ctx) {
  const warning = spacedRootWarning();
  if (warning) ctx.err(warning);
}

// Applies the hook entries to the host settings, writing only when something actually changed.
function applyHooks(ctx, report, { remove }) {
  const settings = readHostSettings(ctx.env);
  const before = structuredClone(settings.data);
  const steps = remove ? removeHooks(settings.data) : mergeHooks(settings.data);
  if (!isDeepStrictEqual(before, settings.data)) writeHostSettings(ctx.env, settings);
  if (!remove) warnOnSpacedRoot(ctx);
  for (const step of steps) report.step(`hook ${step.event}`, step.status);
}

// Registers this package as a local marketplace of the host.
function setupMarketplace(ctx, report) {
  const known = readKnownMarketplace(ctx.env);
  if (marketplaceIsCurrent(known)) {
    report.step(MARKETPLACE_LABEL, "already present");
    return true;
  }
  if (known && !runStep(ctx, report, MARKETPLACE_LABEL, marketplaceRemoveArgs())) return false;
  if (!runStep(ctx, report, MARKETPLACE_LABEL, marketplaceAddArgs())) return false;
  report.step(MARKETPLACE_LABEL, known ? "updated" : "created");
  return true;
}

// Installs the plugin of this package at user scope.
function setupPlugin(ctx, report) {
  if (!readManifest()) {
    report.degrade(MARKETPLACE_LABEL, "no .claude-plugin/marketplace.json in the package");
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

// Downloads the embedding weights, the only network path of the setup.
async function setupModel(ctx, report, { noModel }) {
  if (noModel) {
    report.step("model", "skipped", "--no-model");
    return;
  }
  try {
    const warmup = ctx.warmupImpl ?? warmupModel;
    const result = await warmup({ allowDownload: true }, ctx.env);
    report.step("model", result.downloaded ? "created" : "already present", result.model);
  } catch (err) {
    report.degrade("model", firstLine(err?.message ?? String(err)), "shift embed download");
  }
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
function finish(ctx, report) {
  if (report.count()) ctx.out(`setup finished with ${report.count()} step(s) degraded - run \`shift doctor\``);
  return 0;
}

// Installs everything the host needs to run nightshift, one idempotent step at a time.
async function install(ctx, { noModel }) {
  const report = makeReport(ctx);
  setupHome(ctx, report);
  setupMcp(ctx, report);
  applyHooks(ctx, report, { remove: false });
  setupPlugin(ctx, report);
  await setupModel(ctx, report, { noModel });
  return finish(ctx, report);
}

// Takes the registrations of this package out of the host, keeping the configuration home untouched.
function uninstall(ctx) {
  const report = makeReport(ctx);
  removeMcp(ctx, report);
  applyHooks(ctx, report, { remove: true });
  removePlugin(ctx, report);
  ctx.out(`home: kept (${homeDir(ctx.env)})`);
  return finish(ctx, report);
}

// Runs `shift setup`: registers this package in the host, or removes those registrations with `--remove`.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    "no-model": { type: "boolean" },
    remove: { type: "boolean" },
  });
  checkArgs(positionals, { max: 0, usage: "shift setup [--no-model] [--remove]" });
  if (values.remove === true) return uninstall(ctx);
  return await install(ctx, { noModel: values["no-model"] === true });
}
