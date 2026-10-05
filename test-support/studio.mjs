import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { startStudioServer } from "../src/studio/server.mjs";
import { makeDir } from "./memory.mjs";

export const STUDIO_TOKEN = "studio-test-token";
export const INDEX_HTML = "<!doctype html><title>studio fixture</title>";
export const APP_JS = "console.log('studio fixture');";

// A built-looking studio dist with an index.html and one hashed asset.
export function makeDist(t) {
  const dir = makeDir(t, "studio-dist");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  writeFileSync(join(dir, "assets", "app.js"), APP_JS);
  return dir;
}

// Starts a studio on an ephemeral port for one test, closed when the test ends.
export async function startStudio(t, env, options = {}) {
  const studio = await startStudioServer({ env, port: 0, token: STUDIO_TOKEN, distDir: options.distDir ?? makeDist(t), ...options });
  t.after(() => studio.close());
  return studio;
}

// The cookie header that carries the studio token for a studio on that port.
export function studioCookie(port, token = STUDIO_TOKEN) {
  return `nq_studio_${port}=${token}`;
}

// Sends one request to a studio and answers its status, headers and body as text.
export function send(port, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

// Sends a raw HTTP request over a socket, the only way to put a header on the wire twice; answers the status code.
export function sendRaw(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(`${lines.join("\r\n")}\r\n\r\n`));
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)));
    socket.on("error", reject);
  });
}

// One fake pty child: records what the studio writes, resizes and pauses, and lets a test emit output and an exit.
function fakeChild({ pid, file, args, options }) {
  const listeners = { data: [], exit: [] };
  return {
    pid,
    file,
    args,
    options,
    writes: [],
    resizes: [],
    paused: false,
    exited: false,
    onData: (fn) => listeners.data.push(fn),
    onExit: (fn) => listeners.exit.push(fn),
    write(data) {
      this.writes.push(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    },
    resize(cols, rows) {
      this.resizes.push({ cols, rows });
    },
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    emitData(text) {
      for (const fn of listeners.data) fn(Buffer.from(text));
    },
    emitExit(exitCode = 0, signal = 0) {
      if (this.exited) return;
      this.exited = true;
      for (const fn of listeners.exit) fn({ exitCode, signal });
    },
  };
}

// A node-pty stand-in for the terminal manager, plus a signal recorder that ends a fake child on SIGKILL (and on SIGHUP unless told it ignores hang-ups); with `groupOutlivesLeader` the child's group (claude under node) survives a SIGHUP until a SIGKILL.
export function fakePtyFactory({ ignoresHangUp = false, groupOutlivesLeader = false } = {}) {
  const spawned = [];
  const signals = [];
  let nextPid = 4_000_000;
  const pty = {
    spawn(file, args, options) {
      nextPid += 1;
      const child = fakeChild({ pid: nextPid, file, args, options });
      child.groupAlive = true;
      spawned.push(child);
      return child;
    },
  };
  const isAlive = (child, pid) => Boolean(child) && (pid < 0 && groupOutlivesLeader ? child.groupAlive : !child.exited);
  const killImpl = (pid, signal) => {
    const child = spawned.find((entry) => entry.pid === Math.abs(pid));
    const alive = isAlive(child, pid);
    if (signal === 0) {
      if (!alive) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      return;
    }
    signals.push({ pid, signal });
    if (!alive) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    if (signal === "SIGKILL") child.groupAlive = false;
    if (signal === "SIGKILL" || (signal === "SIGHUP" && !ignoresHangUp)) child.emitExit(null, signal === "SIGKILL" ? 9 : 1);
  };
  return { pty, spawned, signals, killImpl, loadPty: async () => ({ available: true, pty, version: "fake" }) };
}

// Opens a WebSocket to a studio terminal with Node's global client, carrying the headers (Origin, Cookie) a browser would send.
export function openTerm(port, id, { headers = {} } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/term/${id}`, { headers });
  socket.binaryType = "arraybuffer";
  return socket;
}

// Opens a server-sent event stream and collects its events until `until` says it has what it needs, or the timeout fails it.
export function readEvents(port, { path = "/events", headers = {}, until, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = "";
    const req = request({ hostname: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`the stream answered ${res.statusCode}`));
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name) events.push({ name, data: data ? JSON.parse(data) : null });
          cut = buffer.indexOf("\n\n");
        }
        if (until(events)) {
          clearTimeout(timer);
          req.destroy();
          resolve(events);
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`the stream did not deliver in time; got: ${events.map((event) => event.name).join(", ")}`));
    }, timeoutMs);
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}
