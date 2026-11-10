import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentsDir } from "../../src/config/paths.mjs";
import { builtinAgents, parseFrontmatter, resolveAgent, userAgents, writeAgentSkeleton } from "../../src/sessions/agents.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// Writes one user agent file under the home.
function writeUserAgent(env, stem, text) {
  mkdirSync(agentsDir(env), { recursive: true });
  writeFileSync(join(agentsDir(env), `${stem}.md`), text);
}

test("frontmatter parsing reads plain, quoted, folded, literal and list fields and keeps the body", () => {
  const parsed = parseFrontmatter(`---
name: rev
description: >-
  Reviews code
  carefully.
notes: |
  line one
  line two
model: "sonnet"
tools:
  - Read
  - Grep
---
Body here.
`);
  assert.deepEqual(parsed.data, { name: "rev", description: "Reviews code carefully.", notes: "line one\nline two", model: "sonnet", tools: ["Read", "Grep"] });
  assert.equal(parsed.body, "Body here.\n");
  assert.equal(parseFrontmatter("no frontmatter"), null);
});

test("the built-in agents are the plugin's, by their frontmatter names", () => {
  const names = builtinAgents().map((agent) => agent.name);
  for (const name of ["coder", "triager", "architect", "nightqueue-operator"]) assert.ok(names.includes(name), name);
  assert.ok(builtinAgents().every((agent) => agent.source === "builtin" && agent.description.length > 0));
});

test("a valid user agent resolves to its bare name with an --agents JSON carrying its prompt, tools and model", (t) => {
  const env = makeHome(t, "agents-user");
  writeUserAgent(env, "rev", "---\nname: rev\ndescription: Reviews.\ntools: Read, Grep\nmodel: sonnet\n---\nYou review.\n");
  const resolved = resolveAgent("rev", env);
  assert.equal(resolved.kind, "user");
  assert.equal(resolved.agent, "rev");
  assert.deepEqual(JSON.parse(resolved.agentsJson), { rev: { description: "Reviews.", prompt: "You review.", tools: ["Read", "Grep"], model: "sonnet" } });
});

test("built-ins resolve to their plugin name, the operator to its own kind, none to null, an unknown name is refused", (t) => {
  const env = makeHome(t, "agents-resolve");
  assert.deepEqual(resolveAgent("coder", env), { kind: "builtin", name: "coder", agent: "nightqueue:coder", agentsJson: null });
  assert.equal(resolveAgent("nightqueue:triager", env).agent, "nightqueue:triager");
  assert.equal(resolveAgent("operator", env).kind, "operator");
  assert.equal(resolveAgent(undefined, env), null);
  assert.throws(() => resolveAgent("nope", env), /unknown agent `nope`/);
});

test("YAML flow lists and trailing comments parse as YAML reads them; nested forms are refused, never guessed", (t) => {
  const env = makeHome(t, "agents-yaml");
  const definitionOf = (stem, fields) => {
    writeUserAgent(env, stem, `---\nname: ${stem}\ndescription: Does ${stem}.\n${fields}\n---\nYou work.\n`);
    return JSON.parse(resolveAgent(stem, env).agentsJson)[stem];
  };
  assert.deepEqual(definitionOf("flow", "tools: [Read, 'Bash']").tools, ["Read", "Bash"]);
  assert.equal(definitionOf("none", "tools: []").tools, undefined);
  assert.equal(definitionOf("fast", "model: sonnet # fast").model, "sonnet");
  assert.deepEqual(definitionOf("hash", "tools: Read#x, Grep # all").tools, ["Read#x", "Grep"]);
  assert.equal(definitionOf("quoted", 'model: "sonnet" # fast').model, "sonnet");
  assert.equal(definitionOf("single", "model: 'a # b' # c").model, "a # b");
  assert.deepEqual(definitionOf("items", 'tools:\n  - "Read" # c\n  - Grep').tools, ["Read", "Grep"]);
  writeUserAgent(env, "nested", "---\nname: nested\ndescription: Nests.\ntools: [[a]]\n---\nYou nest.\n");
  assert.throws(() => resolveAgent("nested", env), /`tools` uses a YAML form this reader does not support \(nested lists or maps\)/);
  writeUserAgent(env, "mapped", "---\nname: mapped\ndescription: Maps.\ntools: {a: b}\n---\nYou map.\n");
  assert.throws(() => resolveAgent("mapped", env), /`tools` uses a YAML form this reader does not support/);
});

test("the `nightqueue:` prefix names built-ins only; a user agent is called by its bare name", (t) => {
  const env = makeHome(t, "agents-prefix");
  writeUserAgent(env, "myagent", "---\nname: myagent\ndescription: Mine.\n---\nYou are mine.\n");
  assert.equal(resolveAgent("myagent", env).kind, "user");
  assert.throws(() => resolveAgent("nightqueue:myagent", env), /unknown agent `nightqueue:myagent`: .* call a user agent by its bare name/);
});

test("invalid user agents are reported, never loaded: a built-in or reserved name, a mismatched stem, no description, an oversized body", (t) => {
  const env = makeHome(t, "agents-invalid");
  writeUserAgent(env, "coder", "---\nname: coder\ndescription: x\n---\nbody\n");
  writeUserAgent(env, "explore", "---\nname: explore\ndescription: x\n---\nbody\n");
  writeUserAgent(env, "mismatch", "---\nname: other\ndescription: x\n---\nbody\n");
  writeUserAgent(env, "nodesc", "---\nname: nodesc\n---\nbody\n");
  writeUserAgent(env, "huge", `---\nname: huge\ndescription: x\n---\n${"a".repeat(100 * 1024 + 1)}\n`);
  writeUserAgent(env, "Bad_Name", "---\nname: Bad_Name\ndescription: x\n---\nbody\n");
  const { agents, invalid } = userAgents(env);
  assert.deepEqual(agents, []);
  assert.equal(invalid.length, 6);
  assert.throws(() => resolveAgent("nodesc", env), /agent `nodesc` is invalid: .*description/);
  assert.equal(resolveAgent("coder", env).kind, "builtin", "a user file never shadows a built-in");
});

test("`agent new` writes a valid skeleton under the home, never over an existing file, and refuses built-in and reserved names", (t) => {
  const env = makeHome(t, "agents-new");
  const path = writeAgentSkeleton("rev", env);
  assert.equal(path, join(agentsDir(env), "rev.md"));
  assert.equal(realpathSync(join(path, "..")), realpathSync(agentsDir(env)));
  assert.match(readFileSync(path, "utf8"), /## How you operate[\s\S]*## Resources/);
  assert.equal(resolveAgent("rev", env).kind, "user", "the skeleton is usable as written");
  assert.throws(() => writeAgentSkeleton("rev", env), /already exists/);
  assert.throws(() => writeAgentSkeleton("triager", env), /built-in agent/);
  assert.throws(() => writeAgentSkeleton("operator", env), /reserved/);
  assert.throws(() => writeAgentSkeleton("../x", env), /a name is lowercase/);
});
