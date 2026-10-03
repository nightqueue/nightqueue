import { cookieTokenMatches, originIsExactly, rawHeaderValues, respond, tokenMatches } from "../mcp/transports/http-gate.mjs";

const TOKEN_PARAM = "t";
const READ_METHODS = new Set(["GET", "HEAD"]);

// The cookie a studio on this port keeps its token in: one name per port, so two studios on one host never share it.
export function cookieName(port) {
  return `nq_studio_${port}`;
}

// The request target as a URL, or null when it is not one this server could serve.
function targetOf(req) {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}

// The same target without the token parameter, the place the exchange sends the browser back to.
function withoutToken(target) {
  target.searchParams.delete(TOKEN_PARAM);
  return `${target.pathname}${target.search}`;
}

// Exchanges a `?t=<token>` page load for the HttpOnly cookie and a redirect without the token; answers whether it handled the request.
export function exchangeToken(req, res, { token, port }) {
  if (!READ_METHODS.has(req.method)) return false;
  const target = targetOf(req);
  if (!target || !target.searchParams.has(TOKEN_PARAM)) return false;
  const given = target.searchParams.getAll(TOKEN_PARAM);
  if (given.length !== 1 || !tokenMatches(`Bearer ${given[0]}`, token)) {
    respond(res, 401, "invalid studio token; open the URL `nightqueue studio` printed");
    return true;
  }
  res.writeHead(303, {
    location: withoutToken(target),
    "set-cookie": `${cookieName(port)}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    "cache-control": "no-store",
  });
  res.end();
  return true;
}

// How the request proves it holds the token: `"bearer"`, `"cookie"`, or null when it does not; a repeated Authorization header proves nothing.
export function authorise(req, { token, port }) {
  const authorizations = rawHeaderValues(req, "authorization");
  if (authorizations.length === 1 && tokenMatches(authorizations[0], token)) return "bearer";
  if (cookieTokenMatches(req, cookieName(port), token)) return "cookie";
  return null;
}

// Tells whether a request changes state: anything that is not a read.
export function isMutation(req) {
  return !READ_METHODS.has(req.method);
}

// Why a cookie-authorised write is refused, or null: it must carry the studio's own origin exactly, port included.
export function mutationRefusal(req, { auth, allowedOrigins }) {
  if (auth !== "cookie" || !isMutation(req)) return null;
  return originIsExactly(req, allowedOrigins) ? null : "a write from the studio page must carry its exact origin";
}
