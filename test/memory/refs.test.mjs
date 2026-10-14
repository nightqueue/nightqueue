import assert from "node:assert/strict";
import { test } from "node:test";
import {
  jobRef,
  parseJobRef,
  parseRef,
  requireKey,
  suggestKey,
  suggestKeyUnbounded,
} from "../../src/memory/refs.mjs";

const INVALID_KEY = /is invalid: a key is 2 to 5 uppercase letters or digits and starts with a letter/;

test("a key is 2 to 5 letters or digits and starts with a letter", () => {
  assert.equal(requireKey("NQ"), "NQ");
  assert.equal(requireKey("ABCDE"), "ABCDE");
  assert.equal(requireKey("A1B2"), "A1B2");
  for (const bad of ["N", "ABCDEF", "1NQ", "N-Q", "N_Q", "", "N Q", "G", null, 12]) {
    assert.throws(() => requireKey(bad), INVALID_KEY, `accepted ${bad}`);
  }
});

test("a key is trimmed and upper-cased before it is validated", () => {
  assert.equal(requireKey(" nq "), "NQ");
  assert.equal(requireKey("dlw"), "DLW");
  assert.throws(() => requireKey("n"), /key `n` is invalid/);
});


test("a job ref renders from its id", () => {
  assert.equal(jobRef(77), "J-77");
});

test("parseRef reads a job ref or a plain id, case-insensitive and trimmed, and a decision or item-shaped ref is none of them", () => {
  assert.deepEqual(parseRef("J-77"), { kind: "job", id: 77 });
  assert.deepEqual(parseRef("77"), { kind: "job", id: 77 });
  assert.deepEqual(parseRef(77), { kind: "job", id: 77 });
  assert.deepEqual(parseRef("  j-5  "), { kind: "job", id: 5 });
  for (const other of ["D-7", "DLW/D-3", "NQ/D-7", "G/D-1", "d-7 ", "NQ-12", "G-2", "ABCDE-1"]) assert.equal(parseRef(other), null, other);
});

test("parseRef refuses decoys around every delimiter", () => {
  const decoys = [
    "J-0", "NQ-0", "D-0", "0", "NQ-01", "J-", "-5", "J--5", "J 5", "D-", "NQ/D-x", "NQ/D-", "/D-3",
    "NQ/-3", "NQ//D-3", "ABCDEF-1", "1NQ-2", "N-2", "NQ-", "NQ- 12", "NQ -12", "NQ_12", "#12", "NQ#12",
    "NQ-12x", "NQ-1.5", "-", "", "   ", "J-9007199254740993",
  ];
  for (const decoy of decoys) assert.equal(parseRef(decoy), null, `parsed ${JSON.stringify(decoy)}`);
  for (const other of [null, undefined, {}, [], true]) assert.equal(parseRef(other), null);
});

test("parseJobRef takes a job ref or a plain id and refuses anything else", () => {
  assert.equal(parseJobRef(24), 24);
  assert.equal(parseJobRef("24"), 24);
  assert.equal(parseJobRef("J-24"), 24);
  assert.equal(parseJobRef("j-24"), 24);
  for (const bad of ["NQ-24", "D-24", "DLW/D-2", 0, -1, 2.5, "abc", null]) {
    assert.throws(() => parseJobRef(bad), /expected a job ref \(`J-<id>`\) or a job id, got/, `accepted ${bad}`);
  }
});

test("suggestKey derives a key from the name", () => {
  const none = new Set();
  assert.equal(suggestKey("nightqueue", none), "NQ");
  assert.equal(suggestKey("feat-api-web", none), "FAW");
  assert.equal(suggestKey("a-b-c-d-e", none), "ABCD");
  assert.equal(suggestKey("default", none), "DA");
  assert.equal(suggestKey("x", none), "XX");
  assert.equal(suggestKey("123", none), "P1");
  assert.equal(suggestKey("123", none, { kind: "org" }), "O1");
  assert.equal(suggestKey("2nd-api", none), "NA");
  assert.equal(suggestKey("my_app.js", none), "MP");
  assert.equal(suggestKey("---", none), "PP");
});

test("suggestKey adds one letter on a collision and never returns a taken key", () => {
  assert.equal(suggestKey("nightqueue", new Set(["NQ"])), "NQA");
  assert.equal(suggestKey("nightqueue", new Set(["NQ", "NQA"])), "NQB");
  assert.equal(suggestKey("a-b-c-d-e", new Set(["ABCD"])), "ABCDA");
});

test("suggestKey refuses when every candidate is taken", () => {
  const taken = new Set(["NQ", ...[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `NQ${letter}`)]);
  assert.throws(() => suggestKey("nightqueue", taken), /no free key derives from `nightqueue`; pass one with --key <KEY>/);
});

test("suggestKeyUnbounded keeps the suggestKey order and goes on past the letters, never returning a taken key", () => {
  const letters = new Set(["NQ", ...[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `NQ${letter}`)]);
  assert.equal(suggestKeyUnbounded("nightqueue", new Set(["NQ"])), suggestKey("nightqueue", new Set(["NQ"])));
  assert.equal(suggestKeyUnbounded("nightqueue", letters), "NQ0");
  const full = new Set(["ABCD", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].map((char) => `ABCD${char}`));
  const key = suggestKeyUnbounded("a-b-c-d", full);
  assert.ok(!full.has(key) && /^[A-Z][A-Z0-9]{1,4}$/.test(key), key);
});
