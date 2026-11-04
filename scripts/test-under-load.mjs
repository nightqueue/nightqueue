#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_GLOB = "test/**/*.test.mjs";
const BASE_ARGS = ["--test", "--test-timeout=240000", "--disable-warning=ExperimentalWarning", "--test-reporter=junit"];

// Options of one load round, as a declared failure when one is missing or not a positive integer.
function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      round: { type: "string" },
      runs: { type: "string", default: "3" },
      out: { type: "string" },
      only: { type: "string", multiple: true },
    },
  });
  const round = Number(values.round);
  const runs = Number(values.runs);
  if (!Number.isInteger(round) || round < 1) throw new Error("--round must be a positive integer");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  if (!values.out) throw new Error("--out <dir> is required");
  return { round, runs, out: resolve(ROOT, values.out), files: values.only?.length ? values.only : [DEFAULT_GLOB] };
}

// Runs one full node:test suite into a junit file and resolves with its exit code once it ends.
function runSuite({ files, destination }) {
  return new Promise((done) => {
    const args = [...BASE_ARGS, `--test-reporter-destination=${destination}`, ...files];
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "ignore" });
    child.on("error", (err) => done({ code: null, error: err.message }));
    child.on("close", (code) => done({ code, error: null }));
  });
}

const ATTRIBUTES = String.raw`((?:\s+[\w-]+="[^"]*")*)\s*`;
const TESTCASE = new RegExp(String.raw`<testcase${ATTRIBUTES}(?:\/>|>([\s\S]*?)<\/testcase>)`, "g");
const FAILURE = new RegExp(String.raw`<failure${ATTRIBUTES}(?:\/>|>([\s\S]*?)<\/failure>)`);

// Decodes the named and numeric XML entities the junit reporter escapes.
function decodeXml(text) {
  const entities = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
  return text.replace(/&(#\d+|lt|gt|quot|apos|amp);/g, (_, code) => (code.startsWith("#") ? String.fromCharCode(Number(code.slice(1))) : entities[code]));
}

// Value of one attribute of an XML start tag, or an empty string when absent.
function attribute(attributes, name) {
  const match = attributes.match(new RegExp(String.raw`\s${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : "";
}

// First non-empty line of a text, the line that names the error.
function firstLine(text) {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

// Every failing testcase of one junit report, with its file, name and first error line.
function failuresOf(xml, run) {
  const failures = [];
  for (const [, attributes, body = ""] of xml.matchAll(TESTCASE)) {
    const failure = body.match(FAILURE);
    if (!failure) continue;
    const reason = firstLine(attribute(failure[1], "message")) || firstLine(decodeXml(failure[2] ?? ""));
    failures.push({ file: attribute(attributes, "file"), name: attribute(attributes, "name"), run, firstLine: reason });
  }
  return failures;
}

// Failures of one finished run, with an unreadable report counted as one failure of the whole run.
function readRunFailures({ destination, run, result }) {
  try {
    return failuresOf(readFileSync(destination, "utf8"), run);
  } catch (err) {
    return [{ file: destination, name: "<report unreadable>", run, firstLine: `${err.message} (exit ${result.code}${result.error ? `, ${result.error}` : ""})` }];
  }
}

// Runs `runs` suites at once and writes every failure of the round to round-<r>.json.
async function runRound({ round, runs, out, files }) {
  mkdirSync(out, { recursive: true });
  const started = Date.now();
  const plans = Array.from({ length: runs }, (_, k) => ({ run: k + 1, destination: join(out, `round-${round}-run-${k + 1}.xml`) }));
  const results = await Promise.all(plans.map((plan) => runSuite({ files, destination: plan.destination })));
  const failures = plans.flatMap((plan, k) => readRunFailures({ ...plan, result: results[k] }));
  writeFileSync(join(out, `round-${round}.json`), `${JSON.stringify(failures, null, 2)}\n`);
  for (const f of failures) console.log(`run ${f.run} · ${f.file} · ${f.name} · ${f.firstLine}`);
  console.log(`round ${round}: ${failures.length} failures (${runs} runs, ${Math.round((Date.now() - started) / 1000)} s)`);
}

Promise.resolve().then(() => runRound(readOptions(process.argv.slice(2)))).catch((err) => {
  console.error(`test-under-load: ${err.message}`);
  process.exit(2);
});
