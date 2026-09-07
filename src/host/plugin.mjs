import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonOrNull } from "./json.mjs";
import { installedPluginsPath, knownMarketplacesPath, marketplaceManifestPath, packageRoot } from "./paths.mjs";

const DEFAULT_NAME = "nightshift";

// Reads the marketplace manifest shipped with the package, or null when the package does not carry it.
export function readManifest() {
  return readJsonOrNull(marketplaceManifestPath());
}

// Name of the marketplace declared by the manifest.
export function marketplaceName(manifest = readManifest()) {
  return typeof manifest?.name === "string" && manifest.name.trim() ? manifest.name.trim() : DEFAULT_NAME;
}

// Reference of the plugin as the host names it: `<plugin>@<marketplace>`.
export function pluginRef(manifest = readManifest()) {
  const first = Array.isArray(manifest?.plugins) ? manifest.plugins[0] : null;
  const plugin = typeof first?.name === "string" && first.name.trim() ? first.name.trim() : DEFAULT_NAME;
  return `${plugin}@${marketplaceName(manifest)}`;
}

// Canonical form of a path, so that a symlinked package root still compares equal.
function canonical(path) {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

// Every string value of an entry, one level into its nested objects.
function stringValues(entry) {
  const values = [];
  for (const value of Object.values(entry)) {
    if (typeof value === "string") values.push(value);
    else if (value && typeof value === "object") values.push(...Object.values(value).filter((v) => typeof v === "string"));
  }
  return values;
}

// Reads the marketplace entry the host knows for this package, or null when it knows none.
export function readKnownMarketplace(env = process.env) {
  const data = readJsonOrNull(knownMarketplacesPath(env));
  const map = data?.marketplaces && typeof data.marketplaces === "object" ? data.marketplaces : data;
  const name = marketplaceName();
  if (!map || typeof map !== "object" || !Object.hasOwn(map, name)) return null;
  const entry = map[name];
  return entry && typeof entry === "object" ? entry : null;
}

// Tells whether the registered marketplace is this package: only an absolute path pointing at this root proves it, a matching name never does.
export function marketplaceIsCurrent(entry) {
  if (!entry || typeof entry !== "object") return false;
  const root = canonical(packageRoot());
  return stringValues(entry).some((value) => value.startsWith("/") && canonical(value) === root);
}

// Installation state of the plugin, read from disk and tolerant to a file shape this version does not know.
export function readInstalledPlugin(env = process.env) {
  const data = readJsonOrNull(installedPluginsPath(env));
  if (!data) return { state: "absent" };
  if (data.plugins !== undefined && (!data.plugins || typeof data.plugins !== "object")) return { state: "unknown" };
  const map = data.plugins ?? data;
  const ref = pluginRef();
  return Object.hasOwn(map, ref) ? { state: "installed", entry: map[ref] } : { state: "absent" };
}

// Arguments of the call that registers this package as a local marketplace.
export function marketplaceAddArgs() {
  return ["plugin", "marketplace", "add", packageRoot()];
}

// Arguments of the call that forgets the marketplace of this package.
export function marketplaceRemoveArgs() {
  return ["plugin", "marketplace", "remove", marketplaceName()];
}

// Arguments of the call that installs the plugin at user scope, never interactive.
export function pluginInstallArgs() {
  return ["plugin", "install", pluginRef(), "-y", "--scope", "user"];
}

// Arguments of the call that uninstalls the plugin.
export function pluginUninstallArgs() {
  return ["plugin", "uninstall", pluginRef(), "-y", "--scope", "user"];
}
