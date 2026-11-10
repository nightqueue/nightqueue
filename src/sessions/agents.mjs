import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { agentsDir } from "../config/paths.mjs";
import { pluginDir } from "../host/claude-launch.mjs";

export const PLUGIN_AGENT_PREFIX = "nightqueue:";
export const OPERATOR_NAMES = Object.freeze(["operator", "nightqueue-operator"]);
const RESERVED_NAMES = new Set([...OPERATOR_NAMES, "general-purpose", "explore", "plan", "statusline-setup", "output-style-setup", "claude-code-guide"]);
const NAME_SHAPE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BODY_BYTES = 100 * 1024;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FIELD_LINE = /^([A-Za-z][\w-]*):\s*(.*)$/;
const CONTINUATION_LINE = /^(\s+\S.*|\s*)$/;
const AGENT_SUFFIX = ".md";
const TRAILING_COMMENT = /(?:^|\s+)#.*$/;
const QUOTED_SCALAR = /^(["'])(.*?)\1(?:\s+#.*)?$/;
const UNSUPPORTED_FORM = Symbol("unsupported YAML form");

// One quoted scalar without its quotes and its trailing ` # comment`, any other value without the comment.
function unquote(raw) {
  const quoted = QUOTED_SCALAR.exec(raw);
  return quoted ? quoted[2] : raw.replace(TRAILING_COMMENT, "");
}

// The items of a YAML flow list (`[a, b]`, `[]` for none), or UNSUPPORTED_FORM for a nested or unclosed one.
function flowList(raw) {
  const text = raw.replace(TRAILING_COMMENT, "");
  if (!text.endsWith("]")) return UNSUPPORTED_FORM;
  const inner = text.slice(1, -1);
  if (/[[\]{}]/.test(inner)) return UNSUPPORTED_FORM;
  return inner
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

// The value of one frontmatter field from its inline text and its indented continuation lines (`>-`, `|`, `- item` and `[a, b]` lists included).
function fieldValue(raw, block) {
  const lines = block.map((line) => line.trim());
  if (raw.startsWith(">")) return lines.filter(Boolean).join(" ");
  if (raw.startsWith("|")) return lines.join("\n").trim();
  if (raw.startsWith("[")) return flowList(raw);
  if (raw.startsWith("{")) return UNSUPPORTED_FORM;
  const items = lines.filter(Boolean);
  if (raw === "" && items.length > 0 && items.every((line) => line.startsWith("- "))) return items.map((line) => unquote(line.slice(2).trim()));
  return unquote(raw);
}

// The fields of a frontmatter block, one per `key:` line with its indented continuation.
function frontmatterFields(text) {
  const lines = text.split(/\r?\n/);
  const data = {};
  let index = 0;
  while (index < lines.length) {
    const field = FIELD_LINE.exec(lines[index]);
    index += 1;
    if (!field) continue;
    const block = [];
    while (index < lines.length && !FIELD_LINE.test(lines[index]) && CONTINUATION_LINE.test(lines[index])) {
      block.push(lines[index]);
      index += 1;
    }
    data[field[1]] = fieldValue(field[2].trim(), block);
  }
  return data;
}

// The frontmatter fields and the body of an agent file, or null when it opens with no frontmatter.
export function parseFrontmatter(text) {
  if (typeof text !== "string") return null;
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  return { data: frontmatterFields(match[1]), body: text.slice(match[0].length) };
}

// The `.md` files of a directory, none when it does not exist.
function agentFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(AGENT_SUFFIX))
      .sort()
      .map((name) => join(dir, name));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw new UserError(`the agents directory ${dir} cannot be read: ${err.message}`);
  }
}

// The agents the plugin this package carries ships, by their frontmatter name.
export function builtinAgents() {
  const agents = [];
  for (const path of agentFiles(join(pluginDir(), "agents"))) {
    const parsed = parseFrontmatter(readFileSync(path, "utf8"));
    if (typeof parsed?.data.name === "string") agents.push({ name: parsed.data.name, description: String(parsed.data.description ?? ""), source: "builtin", path });
  }
  return agents;
}

// The `tools` field of a user agent as a list, or null when it declares none.
function toolList(value) {
  if (value === undefined) return null;
  const tools = (Array.isArray(value) ? value : String(value).split(",")).map((tool) => String(tool).trim()).filter(Boolean);
  return tools.length > 0 ? tools : null;
}

// Why an agent name cannot be a user agent (shape, reserved, built-in), or null when it can.
export function agentNameProblem(name, builtinNames) {
  if (typeof name !== "string" || !NAME_SHAPE.test(name)) return "a name is lowercase letters, digits and `-`, starting with a letter, at most 64 characters";
  if (RESERVED_NAMES.has(name)) return `\`${name}\` is reserved`;
  if (builtinNames.has(name)) return `\`${name}\` is a built-in agent`;
  return null;
}

// Validates one user agent file and returns the agent, or throws a user error naming what is wrong.
export function validateUserAgent({ path, text, builtinNames }) {
  const stem = basename(path, AGENT_SUFFIX);
  const parsed = parseFrontmatter(text);
  if (!parsed) throw new UserError(`${path}: the file opens with no \`---\` frontmatter`);
  const unsupported = Object.keys(parsed.data).find((key) => parsed.data[key] === UNSUPPORTED_FORM);
  if (unsupported) throw new UserError(`${path}: \`${unsupported}\` uses a YAML form this reader does not support (nested lists or maps)`);
  const { name, description } = parsed.data;
  const problem = agentNameProblem(name, builtinNames);
  if (problem) throw new UserError(`${path}: ${problem}`);
  if (name !== stem) throw new UserError(`${path}: the frontmatter name \`${name}\` differs from the file name \`${stem}\``);
  if (typeof description !== "string" || description.trim() === "") throw new UserError(`${path}: \`description\` is required`);
  if (Buffer.byteLength(parsed.body, "utf8") > MAX_BODY_BYTES) throw new UserError(`${path}: the body is over ${MAX_BODY_BYTES / 1024} KB`);
  if (parsed.body.trim() === "") throw new UserError(`${path}: the body is empty; it is the agent's system prompt`);
  const definition = agentDefinition(parsed);
  return { name, description: definition.description, source: "user", path, definition };
}

// The `--agents` entry of a valid user agent: its description and prompt, plus its tools and model when it declares them.
function agentDefinition({ data, body }) {
  const tools = toolList(data.tools);
  const model = typeof data.model === "string" && data.model.trim() ? data.model.trim() : null;
  return { description: data.description.trim(), prompt: body.trim(), ...(tools ? { tools } : {}), ...(model ? { model } : {}) };
}

// The person's own agents under the home, the valid ones and the problem of each one that is not.
export function userAgents(env = process.env) {
  const builtinNames = new Set(builtinAgents().map((agent) => agent.name));
  const agents = [];
  const invalid = [];
  for (const path of agentFiles(agentsDir(env))) {
    try {
      agents.push(validateUserAgent({ path, text: readFileSync(path, "utf8"), builtinNames }));
    } catch (err) {
      invalid.push({ path, error: err.message });
    }
  }
  return { agents, invalid };
}

// The agent a chat runs as: null for none, the operator, a built-in by its plugin name, or a user agent with its `--agents` JSON.
export function resolveAgent(name, env = process.env) {
  if (name === undefined || name === null) return null;
  const text = String(name);
  const prefixed = text.startsWith(PLUGIN_AGENT_PREFIX);
  const bare = prefixed ? text.slice(PLUGIN_AGENT_PREFIX.length) : text;
  if (OPERATOR_NAMES.includes(bare)) return { kind: "operator", name: bare };
  const builtin = builtinAgents().find((agent) => agent.name === bare);
  if (builtin) return { kind: "builtin", name: bare, agent: `${PLUGIN_AGENT_PREFIX}${bare}`, agentsJson: null };
  if (prefixed) throw new UserError(`unknown agent \`${text}\`: \`${PLUGIN_AGENT_PREFIX}<name>\` names a built-in agent; call a user agent by its bare name`);
  const { agents, invalid } = userAgents(env);
  const user = agents.find((agent) => agent.name === bare);
  if (user) return { kind: "user", name: bare, agent: bare, agentsJson: JSON.stringify({ [bare]: user.definition }) };
  const broken = invalid.find((entry) => basename(entry.path, AGENT_SUFFIX) === bare);
  if (broken) throw new UserError(`agent \`${bare}\` is invalid: ${broken.error}`);
  throw new UserError(`unknown agent \`${bare}\`; run \`nightqueue agent list\` to see them`);
}

// The text of a new user agent: its frontmatter and the two sections an agent method opens with.
function agentSkeleton(name) {
  return `---
name: ${name}
description: >-
  One or two sentences on what ${name} does and when to use it.
---

You are ${name}. Describe the role in one paragraph.

## How you operate

- What you do first, and how you decide.
- What you never do.

## Resources

- The files, tools and commands you rely on.
`;
}

// Writes the skeleton of a new user agent under the home, never over an existing file, and returns its path.
export function writeAgentSkeleton(name, env = process.env) {
  const problem = agentNameProblem(name, new Set(builtinAgents().map((agent) => agent.name)));
  if (problem) throw new UserError(`cannot create agent \`${name}\`: ${problem}`);
  const dir = agentsDir(env);
  const path = join(dir, `${name}${AGENT_SUFFIX}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, agentSkeleton(name), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err?.code === "EEXIST") throw new UserError(`agent \`${name}\` already exists at ${path}`);
    throw new UserError(`cannot write ${path}: ${err.message}`);
  }
  return path;
}
