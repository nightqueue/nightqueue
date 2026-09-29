import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeHome } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

// A blank pr_url is a filter that names nothing: it must be refused, never answered with the whole queue.
for (const blank of ["   ", "", "\t\n"]) {
  test(`queue_status refuses a blank pr_url ${JSON.stringify(blank)}`, async (t) => {
    const env = makeHome(t, "qa-blank-pr-url");
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
    const client = new Client({ name: "nightqueue-qa", version: "0.0.0" });
    await client.connect(transport);
    t.after(() => client.close());
    const result = await client.callTool({ name: "queue_status", arguments: { pr_url: blank } });
    const text = result.content.map((b) => b.text).join("\n");
    assert.equal(result.isError, true, `answered instead of refusing: ${text.slice(0, 200)}`);
  });
}
