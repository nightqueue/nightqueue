import { UserError } from "../config/errors.mjs";
import { orgSlot, orgUsesConnection } from "./connections.mjs";
import { quietFiles } from "./coverage.mjs";
import { isHomeScoped, providerOf, providers } from "./registry.mjs";

export const INTEGRATION_ACTIONS = Object.freeze(["show", "set", "unset"]);

// Tells whether a value is a plain object.
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Every integration setting of this build as `{ key, kind, path, spec }`, in registry order.
function declaredSettings() {
  return providers().flatMap((provider) =>
    Object.entries(provider.settings ?? {}).map(([path, spec]) => ({ key: `${provider.kind}.${path}`, kind: provider.kind, path, spec })),
  );
}

// The full key of every integration setting of this build, as `<kind>.<dotted.key>`.
export function integrationKeys() {
  return declaredSettings().map((setting) => setting.key);
}

// The settings each provider of this build declares, as data an answer can carry.
export function providerSettingsView() {
  return providers().map((provider) => ({
    kind: provider.kind,
    keys: Object.entries(provider.settings ?? {}).map(([path, spec]) => ({
      key: `${provider.kind}.${path}`,
      type: spec.type,
      ...(spec.values ? { values: [...spec.values] } : {}),
      ...(spec.default !== undefined ? { default: spec.default } : {}),
    })),
  }));
}

// The declared setting a full key names; an unknown key is refused with the valid ones.
function requireSetting(key) {
  const declared = declaredSettings();
  if (!declared.length) throw new UserError(`\`${key}\` is not an integration setting: no provider of this build has integration settings`);
  const found = declared.find((setting) => setting.key === key);
  if (found) return found;
  throw new UserError(`unknown integration setting \`${key}\`; valid settings: ${declared.map((setting) => setting.key).join(", ")}`);
}

// Splits a full key into the provider kind and the path of the setting inside it.
function keyParts(key) {
  const [kind, ...path] = key.split(".");
  return [kind, ...path].filter(Boolean);
}

// Reads the value at a path of nested objects, or undefined.
function valueAt(root, parts) {
  return parts.reduce((node, part) => (isPlainObject(node) && Object.hasOwn(node, part) ? node[part] : undefined), root);
}

// A copy of the root with the value written at the path, creating the objects on the way.
function withValueAt(root, [head, ...rest], value) {
  const copy = isPlainObject(root) ? { ...root } : {};
  copy[head] = rest.length ? withValueAt(copy[head], rest, value) : value;
  return copy;
}

// A copy of the root without the value at the path, parents left empty pruned away.
function withoutValueAt(root, [head, ...rest]) {
  if (!isPlainObject(root) || !Object.hasOwn(root, head)) return root;
  const copy = { ...root };
  const child = rest.length ? withoutValueAt(copy[head], rest) : undefined;
  if (child === undefined || (isPlainObject(child) && !Object.keys(child).length)) delete copy[head];
  else copy[head] = child;
  return copy;
}

// The value of a setting for a project, the declared default when it is not set.
export function getSetting(integrations, kind, dottedKey) {
  const stored = valueAt(integrations, [kind, ...dottedKey.split(".")]);
  if (stored !== undefined) return stored;
  return providerOf(kind)?.settings?.[dottedKey]?.default ?? null;
}

// Validates an `enum` value against the declared values.
function parseEnum(setting, text) {
  if (setting.spec.values?.includes(text)) return text;
  throw new UserError(`\`${setting.key}\` takes one of: ${(setting.spec.values ?? []).join(", ")}; got \`${text}\``);
}

// Reads a `boolean` value written as true or false.
function parseBoolean(setting, text) {
  if (text === "true" || text === "false") return text === "true";
  throw new UserError(`\`${setting.key}\` takes true or false; got \`${text}\``);
}

// Reads a `list` value written comma-separated, each entry one of the declared values.
function parseList(setting, text) {
  const entries = [...new Set(text.split(",").map((entry) => entry.trim()).filter(Boolean))];
  const allowed = setting.spec.values ?? [];
  const wrong = entries.filter((entry) => !allowed.includes(entry));
  if (entries.length && !wrong.length) return entries;
  throw new UserError(`\`${setting.key}\` takes a comma-separated list of: ${allowed.join(", ")}; got \`${text}\``);
}

// Validates a `connection` value: a stored connection of the provider's type that the project's org uses.
function parseConnection(setting, name, { orgId, config, secrets }) {
  const record = secrets?.connections?.[name];
  if (!record) throw new UserError(`\`${setting.key}\`: there is no connection named \`${name}\`; see nightqueue connection list`);
  if (record.type !== setting.kind) throw new UserError(`\`${setting.key}\` needs a ${setting.kind} connection; \`${name}\` is a ${record.type} connection`);
  if (!orgUsesConnection({ kind: setting.kind, name, orgId, config })) {
    throw new UserError(`\`${setting.key}\`: connection \`${name}\` is not bound to the project's org; bind it with nightqueue connection bind ${name} --org <org>`);
  }
  return name;
}

const VALUE_PARSERS = { enum: parseEnum, boolean: parseBoolean, list: parseList, connection: parseConnection };

// The stored form of a value given as text for a setting.
function parseValue(setting, value, files) {
  const parse = VALUE_PARSERS[setting.spec?.type];
  if (!parse) throw new UserError(`\`${setting.key}\` has the type \`${setting.spec?.type}\`, which this build cannot set`);
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new UserError(`\`${setting.key}\` needs a value: ${setting.key}=<value>`);
  return parse(setting, text, files);
}

// The integrations after one change: a set validated against the provider, or an unset that prunes empty parents; null when nothing is left.
export function applyIntegrationChange({ current, action, key, value, orgId, config, secrets }) {
  const fullKey = typeof key === "string" ? key.trim() : "";
  if (!fullKey) throw new UserError("name the integration setting as <kind>.<key>");
  const root = isPlainObject(current) ? current : {};
  const [kind] = keyParts(fullKey);
  if (isHomeScoped(kind) && (action === "set" || action === "unset")) throw new UserError(`${kind} has no settings`);
  let next;
  if (action === "set") {
    const setting = requireSetting(fullKey);
    next = withValueAt(root, keyParts(fullKey), parseValue(setting, value, { orgId, config, secrets }));
  } else if (action === "unset") {
    if (valueAt(root, keyParts(fullKey)) === undefined) requireSetting(fullKey);
    next = withoutValueAt(root, keyParts(fullKey));
  } else {
    throw new UserError(`unknown integrations action \`${action}\`; use: set, unset`);
  }
  return Object.keys(next).length ? next : null;
}

// Applies the changes to a project's integrations and stores the result, all of them or none.
export async function changeProjectIntegrations({ store, project, action, changes, env }) {
  if (!Array.isArray(changes) || !changes.length) throw new UserError(`\`${action}\` needs at least one setting`);
  const files = quietFiles(env);
  const current = await store.projects.integrations(project.id);
  const next = changes.reduce(
    (integrations, change) => applyIntegrationChange({ current: integrations, action, ...change, orgId: project.org_id, ...files }),
    current,
  );
  return await store.projects.setIntegrations(project.id, next);
}

// Every stored setting as `{ key, value }`, nested objects flattened to dotted keys and lists joined by commas.
export function settingEntries(integrations, prefix = "") {
  if (!isPlainObject(integrations)) return [];
  return Object.entries(integrations).flatMap(([name, value]) => {
    const key = prefix ? `${prefix}.${name}` : name;
    if (isPlainObject(value)) return settingEntries(value, key);
    return [{ key, value: Array.isArray(value) ? value.join(",") : String(value) }];
  });
}

// The org connection each enabled single-slot provider would use, as `<kind>: org connection <name|none>`.
function orgConnectionLines(integrations, { orgId, config }) {
  if (!isPlainObject(integrations)) return [];
  return Object.keys(integrations)
    .filter((kind) => providerOf(kind)?.connection?.cardinality === "one")
    .map((kind) => `${kind}: org connection ${orgSlot(config, orgId, kind) ?? "none"}`);
}

// The lines that show a project's integrations: one `<key>=<value>` per setting, then the org connections; `no integrations` when there is none.
export function integrationLines(integrations, { orgId, env }) {
  const settings = settingEntries(integrations).map((entry) => `${entry.key}=${entry.value}`);
  if (!settings.length) return ["no integrations"];
  return [...settings, ...orgConnectionLines(integrations, { orgId, config: quietFiles(env).config })];
}

// The answer shape of a project's integrations: the stored value and the settings this build offers.
export function integrationsView(project, integrations) {
  return { project: project.name, integrations: integrations ?? null, providers: providerSettingsView() };
}
