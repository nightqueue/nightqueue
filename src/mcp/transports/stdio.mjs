import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startMaintenance } from "../../queue/maintenance.mjs";
import { createServer } from "../tools.mjs";

// Starts the server over stdio, the only stream the protocol may use in this process, and the maintenance timer it owns.
export async function startStdioServer(env = process.env) {
  const server = createServer(env);
  await server.connect(new StdioServerTransport());
  startMaintenance(env);
  return server;
}
