import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../tools.mjs";

// Starts the server over stdio, the only stream the protocol may use in this process.
export async function startStdioServer(env = process.env) {
  const server = createServer(env);
  await server.connect(new StdioServerTransport());
  return server;
}
