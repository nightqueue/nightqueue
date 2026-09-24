import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { USAGE as DECISION_USAGE } from "../src/cli/decision.mjs";
import { USAGE as QUEUE_USAGE } from "../src/cli/queue.mjs";

const USAGE_BY_GROUP = { queue: QUEUE_USAGE, decision: DECISION_USAGE };

// Every `nightqueue queue`/`nightqueue decision` line of a fenced `sh` block of a doc, comment stripped.
function commandLinesOf(path) {
  const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]);
  return blocks
    .flatMap((block) => block.split("\n"))
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line.startsWith("nightqueue queue ") || line.startsWith("nightqueue decision "));
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

for (const path of ["../docs/cli.md", "../README.md"]) {
  test(`every nightqueue queue/decision line of ${path} matches its USAGE`, () => {
    const lines = commandLinesOf(path);
    assert.ok(lines.length > 0, `no nightqueue queue/decision lines found in ${path}`);
    for (const line of lines) checkLine(line);
  });
}
