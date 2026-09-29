import assert from "node:assert/strict";
import { test } from "node:test";
import { homeDir, requireExplicitHome } from "../src/config/paths.mjs";

test("under a test process the default home is refused", () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "node --test must set NODE_TEST_CONTEXT");
  assert.throws(() => homeDir({}), /refused: a test resolved the default ~\/\.nightqueue/);
  assert.throws(() => homeDir({ NIGHTQUEUE_HOME: "   " }), /refused/);
});

test("under a test process an explicit NIGHTQUEUE_HOME is accepted", () => {
  assert.equal(homeDir({ NIGHTQUEUE_HOME: "/tmp/nq-explicit" }), "/tmp/nq-explicit");
});

test("outside a test process the default home still resolves", () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.match(homeDir({}), /\.nightqueue$/);
  } finally {
    process.env.NODE_TEST_CONTEXT = saved;
  }
});

test("a script helper refuses a missing NIGHTQUEUE_HOME and accepts an explicit one", () => {
  assert.throws(() => requireExplicitHome({}), /needs an explicit NIGHTQUEUE_HOME/);
  assert.equal(requireExplicitHome({ NIGHTQUEUE_HOME: "/tmp/nq-explicit" }), "/tmp/nq-explicit");
});
