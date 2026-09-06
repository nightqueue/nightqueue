import { startServer } from "../mcp/server.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

// Runs `shift mcp`: starts the stdio MCP server and never writes anything but the protocol to stdout.
export async function run(argv, ctx) {
  checkArgs(parseCommand(argv).positionals, { max: 0, usage: "shift mcp" });
  await startServer(ctx.env);
}
