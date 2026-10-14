import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { USAGE as QUEUE_USAGE } from "../src/cli/queue.mjs";

const USAGE_BY_GROUP = { queue: QUEUE_USAGE };

// Every `nightqueue queue` line of a fenced `sh` block of a doc, comment stripped.
function commandLinesOf(path) {
  const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]);
  return blocks
    .flatMap((block) => block.split("\n"))
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line.startsWith("nightqueue queue "));
}

// The subcommand names a doc line points at: the word right after the group, plus every `| word` chained after it.
function subcommandsOf(words) {
  const names = [words[2]];
  let index = 3;
  while (words[index] === "|") {
    names.push(words[index + 1]);
    index += 2;
  }
  return names;
}

// Every `--flag` token written anywhere on the line, brackets and quotes included.
function flagsOf(line) {
  return line.match(/--[a-zA-Z][\w-]*/g) ?? [];
}

// Checks one doc line against the USAGE map of its group: every subcommand it names is real, every flag it writes belongs to one of them.
function checkLine(line) {
  const words = line.split(/\s+/);
  const usage = USAGE_BY_GROUP[words[1]];
  assert.ok(usage, `unknown command group in doc line: ${line}`);
  const subcommands = subcommandsOf(words);
  for (const name of subcommands) {
    assert.ok(usage[name], `\`${words[1]} ${name}\` is not a subcommand of \`nightqueue ${words[1]}\`; doc line: ${line}`);
  }
  const usageTexts = subcommands.map((name) => usage[name]).filter(Boolean);
  for (const flag of flagsOf(line)) {
    assert.ok(
      usageTexts.some((text) => new RegExp(`${flag}(?![\\w-])`).test(text)),
      `\`${flag}\` is not in the usage of ${subcommands.join("/")}; doc line: ${line}`,
    );
  }
}

const REMOVED_DECISION_NAMES = /nightqueue decision\b|\bdecision_(save|update|list|recall)\b/;

// Every markdown file of docs/, as a path relative to this test, plus the README.
function docPaths() {
  const docsDir = fileURLToPath(new URL("../docs/", import.meta.url));
  const docs = readdirSync(docsDir, { recursive: true }).filter((name) => String(name).endsWith(".md"));
  return [...docs.map((name) => `../docs/${name}`), "../README.md"];
}

test("no doc nor the README names the removed decision command or tools", () => {
  const hits = docPaths().flatMap((path) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
      .split("\n")
      .map((line, index) => ({ path, line, number: index + 1 }))
      .filter(({ line }) => REMOVED_DECISION_NAMES.test(line)),
  );
  assert.deepEqual(hits.map(({ path, number, line }) => `${path}:${number}: ${line}`), []);
});

for (const path of ["../docs/cli.md", "../README.md"]) {
  test(`every nightqueue queue line of ${path} matches its USAGE`, () => {
    const lines = commandLinesOf(path);
    assert.ok(lines.length > 0, `no nightqueue queue lines found in ${path}`);
    for (const line of lines) checkLine(line);
  });
}
