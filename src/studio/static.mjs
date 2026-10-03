import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { respond } from "../mcp/transports/http-gate.mjs";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".map": "application/json",
};

const IMMUTABLE = "public, max-age=31536000, immutable";

// The decoded path of a request target, or null when it cannot be decoded or carries a NUL byte.
function decodedPath(url) {
  const raw = String(url ?? "/").split(/[?#]/)[0];
  try {
    const path = decodeURIComponent(raw);
    return path.includes("\0") ? null : path;
  } catch {
    return null;
  }
}

// The file of the dist a path names, or null when it would resolve outside of it.
function fileInside(distDir, path) {
  const root = resolve(distDir);
  const file = resolve(root, `.${path}`);
  return file === root || file.startsWith(`${root}${sep}`) ? file : null;
}

// Tells whether a file exists and is a regular file.
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// Tells whether a request is a page navigation the single-page app answers: a GET with no extension that accepts HTML.
function isPageNavigation(req, path) {
  return extname(path) === "" && String(req.headers.accept ?? "").includes("text/html");
}

// Writes one file of the dist with its content type and the cache rule of its place: hashed assets forever, everything else never.
async function sendFile(req, res, file, path) {
  const body = await readFile(file);
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  const cache = path.startsWith("/assets/") ? IMMUTABLE : "no-store";
  res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": cache });
  res.end(req.method === "HEAD" ? undefined : body);
}

// Serves the built studio: a file of the dist, index.html for a page navigation, 404 for anything else or anything outside it.
export async function serveStatic(req, res, { distDir }) {
  if (req.method !== "GET" && req.method !== "HEAD") return respond(res, 405, "the studio pages only answer GET");
  const path = decodedPath(req.url);
  const file = path === null ? null : fileInside(distDir, path === "/" ? "/index.html" : path);
  if (file && (await isFile(file))) return await sendFile(req, res, file, path);
  if (path !== null && isPageNavigation(req, path)) return await sendFile(req, res, resolve(distDir, "index.html"), "/index.html");
  return respond(res, 404, "not found");
}
