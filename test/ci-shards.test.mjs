import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const CI_YML = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const GLOB = '"test/**/*.test.mjs"';
const SHARDS_LINE = "shard: ['1/3', '2/3', '3/3']";

// Returns the text of one top-level job of ci.yml, from its id to the next job id.
function jobBlock(id) {
  const lines = CI_YML.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  if (start < 0) throw new Error(`ci.yml has no job "${id}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

// Parses a matrix shard list like ['1/3', '2/3'] into { index, total } pairs.
function parseShards(block) {
  const match = block.match(/shard: \[([^\]]*)\]/);
  if (!match) throw new Error("job has no shard matrix");
  return [...match[1].matchAll(/'(\d+)\/(\d+)'/g)].map(([, index, total]) => ({ index: Number(index), total: Number(total) }));
}

test("test:shard is the test script with --test-shard placed before the glob", () => {
  const { test: whole, "test:shard": shard } = PACKAGE.scripts;
  assert.ok(whole.endsWith(GLOB), "the test script ends with the glob");
  assert.equal(shard, whole.replace(GLOB, () => `--test-shard=$TEST_SHARD ${GLOB}`));
});

for (const id of ["test", "test-worktree"]) {
  test(`the ${id} job runs one shard per matrix entry`, () => {
    const block = jobBlock(id);
    assert.ok(block.includes(SHARDS_LINE), `${id} declares ${SHARDS_LINE}`);
    assert.match(block, /run: npm run test:shard\n(\s+working-directory: .*\n)?\s+env:\n\s+TEST_SHARD: \$\{\{ matrix\.shard \}\}/);
  });

  test(`the ${id} shards cover 1..N exactly once`, () => {
    const shards = parseShards(jobBlock(id));
    const totals = new Set(shards.map((shard) => shard.total));
    assert.equal(totals.size, 1, "every shard names the same total");
    const [total] = totals;
    assert.deepEqual(shards.map((shard) => shard.index).sort((a, b) => a - b), Array.from({ length: total }, (_, i) => i + 1));
  });
}

test("test-worktree still runs its shard from the worktree", () => {
  const block = jobBlock("test-worktree");
  assert.match(block, /run: git worktree add \.claude\/worktrees\/ci HEAD/);
  assert.match(block, /run: npm run test:shard\n\s+working-directory: \.claude\/worktrees\/ci\n/);
});

test("the test job keeps its Node 22 and 24 axis", () => {
  assert.ok(jobBlock("test").includes("node: ['22', '24']"));
});

test("ci.yml never runs the unsharded suite", () => {
  assert.doesNotMatch(CI_YML, /run: npm test\b/);
});
