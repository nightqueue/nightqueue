import { readFileSync } from "node:fs";
import { ghPrViewResults } from "./gh.mjs";

// The batch request on stdin: the pull request URLs and the time every gh call of the batch may take in all.
function readRequest() {
  const request = JSON.parse(readFileSync(0, "utf8"));
  if (!Array.isArray(request?.urls) || !Number.isFinite(request?.timeoutMs)) throw new Error("expected {urls: string[], timeoutMs: number} on stdin");
  return { urls: request.urls.map(String), timeoutMs: request.timeoutMs };
}

// Prints one raw `gh pr view` answer per pull request URL of the request, read in parallel within its time, for the operator guard's synchronous check.
async function main() {
  try {
    const { urls, timeoutMs } = readRequest();
    process.stdout.write(JSON.stringify(await ghPrViewResults(urls, { timeoutMs })));
  } catch (err) {
    process.stderr.write(`gh-pr-batch: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

await main();
