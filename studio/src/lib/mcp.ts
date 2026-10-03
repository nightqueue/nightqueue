import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { useQuery } from "@tanstack/react-query";

// A tool call the server answered with `isError`, carrying the tool's own text.
export class ToolError extends Error {}

let connecting: Promise<Client> | null = null;

// The one MCP client of the page, connected on first use; a failed connection is retried by the next call.
function connectClient(): Promise<Client> {
  if (connecting) return connecting;
  const client = new Client({ name: "nightqueue-studio", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", window.location.origin));
  connecting = client
    .connect(transport)
    .then(() => client)
    .catch((err: unknown) => {
      connecting = null;
      throw err;
    });
  return connecting;
}

// The text of the first content block of a tool result, the JSON answer every nightqueue tool sends.
function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  const first = Array.isArray(content) ? (content[0] as { type?: string; text?: unknown }) : null;
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

// Calls one MCP tool and answers its parsed JSON; a tool error or an unreadable answer throws a ToolError.
export async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const client = await connectClient();
  const result = await client.callTool({ name, arguments: args });
  const text = resultText(result);
  if ((result as { isError?: boolean }).isError) throw new ToolError(text || `${name} failed`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError(`${name} answered something that is not JSON`);
  }
}

// Whether the MCP endpoint answers, and how many tools it lists, re-checked every 30 seconds.
export function useMcpStatus() {
  return useQuery({
    queryKey: ["mcp-status"],
    queryFn: async () => {
      const client = await connectClient();
      const { tools } = await client.listTools();
      return { tools: tools.length };
    },
    refetchInterval: 30_000,
    retry: 1,
  });
}
