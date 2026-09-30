import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../host/paths.mjs";

const SECTION = /\{\{([#^])([A-Z_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VARIABLE = /\{\{([A-Z_]+)\}\}/g;
const PARTIAL = /\{\{>([\w-]+)\}\}\n?/g;
const BLOCK_TAG_LINE = /^(\{\{[#^/][A-Z_]+\}\})\n/gm;
const MAX_PARTIAL_DEPTH = 3;

// The directory of the resolve skill, inside the plugin of this runtime.
export function resolveSkillDir() {
  return join(packageRoot(), "plugin", "skills", "resolve");
}

// The `references/` directory of the resolve skill, where the files the runtime renders ship.
export function skillReferencesDir() {
  return join(resolveSkillDir(), "references");
}

// The text of one template file, refusing a template the runtime does not ship.
function loadTemplate(dir, name) {
  try {
    return readFileSync(join(dir, `${name}.md`), "utf8");
  } catch (error) {
    throw new Error(`the prompt template \`${name}\` cannot be read from ${dir}: ${error?.message ?? String(error)}`);
  }
}

// The template with every `{{>partial}}` line replaced by the partial's own text, read from the same directory.
function expandPartials(dir, text, depth = 0) {
  if (depth > MAX_PARTIAL_DEPTH) throw new Error("prompt partials nest too deep");
  return text.replace(PARTIAL, (_match, name) => {
    const partial = expandPartials(dir, loadTemplate(dir, name), depth + 1);
    return partial.endsWith("\n") ? partial : `${partial}\n`;
  });
}

// True when a section flag is on: `true`, or a text with content.
function isOn(value) {
  return value === true || (typeof value === "string" && value.trim() !== "");
}

// Refuses a placeholder the values do not resolve, so a half-filled template never leaves the runtime.
function requireValue(values, name) {
  if (!Object.hasOwn(values, name) || values[name] === undefined || values[name] === null) {
    throw new Error(`the prompt placeholder \`${name}\` has no value`);
  }
  return values[name];
}

// Keeps or drops every `{{#FLAG}}…{{/FLAG}}` and `{{^FLAG}}…{{/FLAG}}` section, innermost last, until none is left.
function applySections(text, values) {
  let current = text.replace(BLOCK_TAG_LINE, (_match, tag) => tag);
  for (;;) {
    const next = current.replace(SECTION, (_match, kind, name, body) => ((kind === "#") === isOn(requireValue(values, name)) ? body : ""));
    if (next === current) return current;
    current = next;
  }
}

// Replaces every `{{NAME}}` with its value, after refusing any tag the renderer does not know.
function applyValues(text, values) {
  const unknown = text.replace(VARIABLE, "").match(/\{\{[^}]*\}\}?/);
  if (unknown) throw new Error(`the prompt template carries an unresolved tag \`${unknown[0]}\``);
  return text.replace(VARIABLE, (_match, name) => String(requireValue(values, name)));
}

// Renders one template of a directory with its values: partials, then sections, then values; an unresolved placeholder throws.
export function renderSkillTemplate(dir, name, values) {
  const text = applyValues(applySections(expandPartials(dir, loadTemplate(dir, name)), values), values);
  return `${text.replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
