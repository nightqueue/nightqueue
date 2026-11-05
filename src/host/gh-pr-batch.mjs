import { readFileSync } from "node:fs";
import { ghPrViewResults } from "./gh.mjs";

// The batch request on stdin: the pull request URLs and the parent's deadline (epoch ms) every gh call of the batch must end by.
function readRequest() {
  const request = JSON.parse(readFileSync(0, "utf8"));
  if (!Array.isArray(request?.urls) || !Number.isFinite(request?.deadline)) throw new Error("expected {urls: string[], deadline: number} on stdin");
  return { urls: request.urls.map(String), deadline: request.deadline };
}

// Prints one raw `gh pr view` answer per pull request URL of the request, read in parallel within its time, for the operator guard's synchronous check.
async function main() {
  try {
    const { urls, deadline } = readRequest();
    process.stdout.write(JSON.stringify(await ghPrViewResults(urls, { deadline })));
  } catch (err) {
    process.stderr.write(`gh-pr-batch: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

await main();
