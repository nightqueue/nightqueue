import { createServer as createHttpServer } from "node:http";
import { UserError } from "../../config/errors.mjs";
import { startMaintenance, stopMaintenance } from "../../queue/maintenance.mjs";
import { failRequest, listenOn, loopbackRefusal, requestPath, respond, serveMcp, stopOnSignal, tokenMatches } from "./http-gate.mjs";
import { checkSchemaOrWarn } from "./startup-store.mjs";

export const DEFAULT_HTTP_PORT = 4747;
const MCP_PATH = "/mcp";

// Serves one request behind the loopback gate, the token gate and the endpoint gate, in that order.
async function handleMcpRequest(req, res, { env, token }) {
  const refusal = loopbackRefusal(req);
  if (refusal) return respond(res, 403, refusal);
  if (!tokenMatches(req.headers.authorization, token)) return respond(res, 401, "missing or invalid bearer token");
  if (requestPath(req.url) !== MCP_PATH) return respond(res, 404, `unknown path; the MCP endpoint is ${MCP_PATH}`);
  if (req.method !== "POST") return respond(res, 405, "the MCP endpoint only accepts POST");
  await serveMcp(req, res, env);
}

// Starts the loopback Streamable HTTP listener, and the one maintenance timer of this process, resolving only once it is accepting requests.
export async function startHttpServer({ env = process.env, port = DEFAULT_HTTP_PORT, token, host = "127.0.0.1" }) {
  if (typeof token !== "string" || token === "") throw new UserError("the http transport needs a token to serve with");
  await checkSchemaOrWarn(env);
  const server = createHttpServer((req, res) => {
    handleMcpRequest(req, res, { env, token }).catch((err) => failRequest(res, err));
  });
  const boundPort = await listenOn(server, port, host);
  startMaintenance(env);
  const close = () => {
    stopMaintenance(env);
    server.close();
    server.closeAllConnections();
  };
  stopOnSignal(close);
  return { url: `http://${host}:${boundPort}${MCP_PATH}`, port: boundPort, close };
}
