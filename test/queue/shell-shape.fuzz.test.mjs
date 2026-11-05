import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { CHAIN_SHAPE, UNTERMINATED_QUOTE_SHAPE, consentBash } from "../../src/queue/operator-bands.mjs";
import { bareTokens, checkoutRoots, hasUnquotedCaret, mainBashAllowed } from "../../src/queue/operator-scope.mjs";
import { maskQuoted, orchestratorBashAllowed, shellShapeRefusal, tokenize } from "../../src/queue/orchestrator-scope.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const SEED = 0x5eed1105;
const ROUNDS = 400;
const PREFIX = "git commit -m ";
const BARE_ALPHABET = "abc019._=/-";
const OPERATOR_ALPHABET = ";&|<>()#^$`\" abc";
const DOUBLE_ALPHABET = ";&|<>()#^' abc";
const ANSI_ALPHABET = ";&|<>()#^$`\" abc";
const INJECTED_OPERATORS = [";", "&", "|", "<", ">", "`", "$x", "&&", "||", ">>", "2>&1", "$HOME"];
const RAW_INJECTIONS = ["\\", "\r", "\n", "\u0001", "\u0000", "\u001b"];

// A seeded mulberry32 generator, so every run draws the same commands.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// One random element of a list or of the characters of a string.
function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

// A random run of 1 to `max` characters drawn from an alphabet.
function drawText(random, alphabet, max = 6) {
  const length = 1 + Math.floor(random() * max);
  return Array.from({ length }, () => pick(random, alphabet)).join("");
}

// One word segment as `{ raw, literal }`: a bare run, or a single-, double- or `$'`-quoted run whose body holds shell operators.
function drawSegment(random) {
  const kind = pick(random, ["bare", "single", "double", "ansi"]);
  if (kind === "bare") {
    const text = drawText(random, BARE_ALPHABET);
    return { raw: text, literal: text };
  }
  if (kind === "single") {
    const body = drawText(random, OPERATOR_ALPHABET);
    return { raw: `'${body}'`, literal: body };
  }
  const body = drawText(random, kind === "double" ? DOUBLE_ALPHABET : ANSI_ALPHABET);
  return kind === "double" ? { raw: `"${body}"`, literal: body } : { raw: `$'${body}'`, literal: body };
}

// One word glued from 1 to 3 segments, with the literal argument zsh would pass for it.
function drawWord(random) {
  const segments = Array.from({ length: 1 + Math.floor(random() * 3) }, () => drawSegment(random));
  return { raw: segments.map((s) => s.raw).join(""), literal: segments.map((s) => s.literal).join(""), segments };
}

// A `git commit -m …` command of 1 to 4 generated words, with the argv zsh would run.
function drawCommand(random) {
  const words = Array.from({ length: 1 + Math.floor(random() * 4) }, () => drawWord(random));
  return { command: `${PREFIX}${words.map((w) => w.raw).join(" ")}`, argv: ["git", "commit", "-m", ...words.map((w) => w.literal)], words };
}

// A home with one registered checkout, a user home and a Claude config dir of its own.
function fuzzFixture(t) {
  const env = makeHome(t, "shell-shape-fuzz");
  const base = makeDir(t, "shell-shape-fuzz-host");
  Object.assign(env, { HOME: join(base, "user"), CLAUDE_CONFIG_DIR: join(base, "claude") });
  return { env, checkout: makeProject(t, env, "alpha") };
}

// Asserts that the raw and the masked tokenization align word for word, with the same length per word.
function assertAligned(command, label) {
  const masked = maskQuoted(command);
  assert.equal(masked.length, command.length, `${label}: the mask keeps the length`);
  const raw = tokenize(command);
  const hidden = tokenize(masked);
  assert.equal(hidden.length, raw.length, `${label}: token count`);
  raw.forEach((word, index) => assert.equal(hidden[index].length, word.length, `${label}: word ${index}`));
}

// Asserts that a refused shape is refused by the operator's bare tokens and consent and by the orchestrator alike.
function assertRefusedOnBothPaths(command, { cwd, env }, label) {
  assert.notEqual(shellShapeRefusal(command), null, `${label}: shape`);
  assert.equal(bareTokens(command), null, `${label}: operator bareTokens`);
  assert.ok(consentBash(command, { cwd, env }).shape, `${label}: operator consentBash`);
  assert.equal(orchestratorBashAllowed(command), false, `${label}: orchestrator denial`);
}

// Splices a text into a command at one index.
function spliceAt(command, index, text) {
  return `${command.slice(0, index)}${text}${command.slice(index)}`;
}

test("fuzz: a quoted shell operator is one literal word on both paths, and the raw and masked tokens align", (t) => {
  const { env, checkout } = fuzzFixture(t);
  const random = seededRandom(SEED);
  for (let round = 0; round < ROUNDS; round += 1) {
    const { command, argv } = drawCommand(random);
    const label = `seed ${SEED} round ${round} ${JSON.stringify(command)}`;
    assert.equal(shellShapeRefusal(command), null, `${label}: shape`);
    assertAligned(command, label);
    assert.deepEqual(tokenize(command), argv, `${label}: tokenize`);
    assert.deepEqual(bareTokens(command), argv, `${label}: operator bareTokens`);
    const consent = consentBash(command, { cwd: checkout, env });
    assert.equal(consent.shape, undefined, `${label}: operator consentBash ${consent.shape}`);
    assert.deepEqual(consent.argv, argv.slice(1), `${label}: consent argv`);
    assert.equal(orchestratorBashAllowed(command), true, `${label}: orchestrator`);
  }
});

test("fuzz: an operator injected outside quotes is the chaining shape on both paths", (t) => {
  const { env, checkout } = fuzzFixture(t);
  const random = seededRandom(SEED + 1);
  for (let round = 0; round < ROUNDS; round += 1) {
    const { command } = drawCommand(random);
    const operator = pick(random, INJECTED_OPERATORS);
    const injected = random() < 0.5 ? `${command} ${operator} id` : spliceAt(command, PREFIX.length, `${operator} `);
    const label = `seed ${SEED + 1} round ${round} ${JSON.stringify(injected)}`;
    assert.equal(shellShapeRefusal(injected), "operator", `${label}: shape`);
    assertRefusedOnBothPaths(injected, { cwd: checkout, env }, label);
    assert.equal(consentBash(injected, { cwd: checkout, env }).shape, CHAIN_SHAPE, `${label}: chain shape`);
  }
});

test("fuzz: an expansion opened inside double quotes stays refused on both paths", (t) => {
  const { env, checkout } = fuzzFixture(t);
  const random = seededRandom(SEED + 2);
  for (let round = 0; round < ROUNDS; round += 1) {
    const { command } = drawCommand(random);
    const expansion = pick(random, ["$(id)", "`id`", "$HOME", "${x}"]);
    const injected = `${command} "${drawText(random, "abc ;")}${expansion}"`;
    const label = `seed ${SEED + 2} round ${round} ${JSON.stringify(injected)}`;
    assert.equal(shellShapeRefusal(injected), "operator", `${label}: shape`);
    assertRefusedOnBothPaths(injected, { cwd: checkout, env }, label);
  }
});

test("fuzz: a quote left open is the unterminated shape on both paths", (t) => {
  const { env, checkout } = fuzzFixture(t);
  const random = seededRandom(SEED + 3);
  for (let round = 0; round < ROUNDS; round += 1) {
    const { command } = drawCommand(random);
    const opening = pick(random, ["'", '"', "$'"]);
    const open = `${command} ${opening}${drawText(random, ";&|<> abc")}`;
    const label = `seed ${SEED + 3} round ${round} ${JSON.stringify(open)}`;
    assert.equal(shellShapeRefusal(open), "unterminated", `${label}: shape`);
    assertRefusedOnBothPaths(open, { cwd: checkout, env }, label);
    assert.equal(consentBash(open, { cwd: checkout, env }).shape, UNTERMINATED_QUOTE_SHAPE, `${label}: unterminated shape`);
  }
});

test("fuzz: a backslash, line break or control character anywhere, quoted or not, is refused on both paths", (t) => {
  const { env, checkout } = fuzzFixture(t);
  const random = seededRandom(SEED + 4);
  for (let round = 0; round < ROUNDS; round += 1) {
    const { command } = drawCommand(random);
    const index = PREFIX.length + Math.floor(random() * (command.length - PREFIX.length));
    const injected = spliceAt(command, index, pick(random, RAW_INJECTIONS));
    const label = `seed ${SEED + 4} round ${round} ${JSON.stringify(injected)}`;
    assert.ok(["raw", "unterminated"].includes(shellShapeRefusal(injected)), `${label}: shape ${shellShapeRefusal(injected)}`);
    assertRefusedOnBothPaths(injected, { cwd: checkout, env }, label);
  }
});

test("fuzz: a foreign blank between words is refused on both paths", (t) => {
  const { env, checkout } = fuzzFixture(t);
  const random = seededRandom(SEED + 5);
  for (let round = 0; round < ROUNDS; round += 1) {
    const { command } = drawCommand(random);
    const blank = pick(random, [" ", " ", " ", "　", "﻿"]);
    const injected = `${command}${blank}x`;
    const label = `seed ${SEED + 5} round ${round} ${JSON.stringify(injected)}`;
    assert.equal(shellShapeRefusal(injected), "foreign-blank", `${label}: shape`);
    assertRefusedOnBothPaths(injected, { cwd: checkout, env }, label);
  }
});

test("poc: the mandatory-validation vectors get the same verdict on the operator and the orchestrator", (t) => {
  const { env, checkout } = fuzzFixture(t);
  const ctx = { cwd: checkout, env };
  const passes = [
    "git commit -m 'feat(x): y' -m 'a; b <c> | d & e'",
    "gh pr create --title t --body '## A <!-- x --> ; |'",
    "git log --format='%h %an <%ae>' -3",
    `git -C ${checkout} -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-lazy-fetch grep -e 'a<b' -- 'src/*.mjs' ':(top,exclude,glob)**/.env*'`,
    'git commit -m "a; b"',
    "git commit -m $'a;b'",
  ];
  for (const command of passes) {
    assert.equal(shellShapeRefusal(command), null, command);
    assertAligned(command, command);
    assert.notEqual(bareTokens(command), null, command);
    assert.equal(consentBash(command, ctx).shape, undefined, command);
  }
  for (const command of [passes[0], passes[1], passes[4], passes[5]]) assert.equal(orchestratorBashAllowed(command), true, command);
  const chains = ["git status; rm x", "git log | cat", "git log > f", "git log < f", "git log && x", "'x';'y'", "'a' ; 'b'", 'git log "$(x)"', 'git log "`x`"', "git log $HOME"];
  for (const command of chains) {
    assert.equal(shellShapeRefusal(command), "operator", command);
    assertRefusedOnBothPaths(command, ctx, command);
    assert.equal(consentBash(command, ctx).shape, CHAIN_SHAPE, command);
  }
  assert.equal(orchestratorBashAllowed('"a;"b'), false, "a quoted `;` glued to a word is literal, never an allowed command");
  for (const command of ["git commit -m 'a; b", 'git commit -m "a; b', "git commit -m $'a; b"]) {
    assert.equal(shellShapeRefusal(command), "unterminated", command);
    assertRefusedOnBothPaths(command, ctx, command);
  }
  for (const command of ["git commit -m 'a'\\''b; c'", "git log --out\\put=f", "git log $'\\x3b'x", "git log\rx", "git log x"]) {
    assertRefusedOnBothPaths(command, ctx, JSON.stringify(command));
  }
  assert.equal(orchestratorBashAllowed("git status --short x"), true, "the baseline row is allowed");
  const roots = checkoutRoots(env).roots;
  assert.equal(mainBashAllowed(`git -C ${checkout} show 'HEAD@{1}'`, roots), true, "the quoted baseline read is free");
  for (const suffix of ["HEAD^", "HEAD@{1}", "(x)", "#x"]) assert.equal(orchestratorBashAllowed(`git status --short ${suffix}`), false, suffix);
  for (const suffix of ["HEAD@{1}", "(x)", "#x"]) assert.equal(mainBashAllowed(`git -C ${checkout} show ${suffix}`, roots), false, suffix);
  assert.equal(hasUnquotedCaret(`git -C ${checkout} show HEAD^`), true, "the operator guard refuses an unquoted caret before any band");
});
