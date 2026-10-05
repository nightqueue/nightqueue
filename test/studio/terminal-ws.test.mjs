import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { acceptUpgrade, acceptValue, MAX_MESSAGE_BYTES } from "../../src/studio/websocket.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { fakePtyFactory, openTerm, send, startStudio, STUDIO_TOKEN, studioCookie } from "../../test-support/studio.mjs";

const TIMING = { killGraceMs: 30, exitedTtlMs: 1000 };
const UNKNOWN_ID = "0123456789abcdef";

// A studio whose terminals run on a fake pty, with the headers a page of its own origin sends.
async function termStudio(t, options = {}) {
  const env = makeHome(t, "studio-term");
  const checkout = makeDir(t, "checkout");
  const fake = fakePtyFactory();
  const deps = {
    loadPty: fake.loadPty,
    killImpl: fake.killImpl,
    psImpl: () => null,
    isAlive: () => false,
    readProject: async () => ({ name: "alpha", path: checkout }),
    err: () => {},
  };
  const studio = await startStudio(t, env, { ...options, terminal: { deps, timing: TIMING } });
  const headers = { origin: studio.origin, cookie: studioCookie(studio.port) };
  return { env, fake, studio, port: studio.port, headers };
}

// Opens an operator terminal through the API, answering its id.
async function openOperator({ port, headers }) {
  const answer = await send(port, { method: "POST", path: "/api/terminals", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ kind: "operator", project: "alpha" }) });
  assert.equal(answer.status, 201, answer.body);
  return JSON.parse(answer.body).terminal.id;
}

// Waits until a condition holds, failing after a short while.
async function eventually(check, label) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

// A global WebSocket that collects what it receives and how it closed.
function trackedTerm(port, id, headers) {
  const socket = openTerm(port, id, { headers });
  const seen = { text: "", closed: null };
  socket.addEventListener("message", (event) => {
    seen.text += Buffer.from(event.data).toString("utf8");
  });
  socket.addEventListener("close", (event) => {
    seen.closed = { code: event.code, reason: event.reason };
  });
  return { socket, seen };
}

// One unmasked server frame off the front of a buffer, or null while it is incomplete.
function parseServerFrame(buffer) {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return { frame: { opcode: buffer[0] & 0x0f, payload: buffer.subarray(offset, offset + length) }, size: offset + length };
}

// A client frame, masked unless the test wants a protocol violation.
function clientFrame(opcode, payload, { masked = true, fin = true, declared = null } = {}) {
  const length = declared ?? payload.length;
  const header = length < 126 ? Buffer.from([0, length]) : Buffer.alloc(10);
  if (length >= 126) {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!masked) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

// Sends a raw upgrade request and answers its status line, response text and a reader of the frames that follow.
function rawUpgrade(port, { path, headers = {}, version = "13" }) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, `Sec-WebSocket-Version: ${version}`];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    const socket = connect(port, "127.0.0.1", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
    const reader = { buffer: Buffer.alloc(0), frames: [], waiters: [], ended: false };
    let head = null;
    socket.on("data", (chunk) => {
      reader.buffer = Buffer.concat([reader.buffer, chunk]);
      if (head === null) {
        const cut = reader.buffer.indexOf("\r\n\r\n");
        if (cut < 0) return;
        head = reader.buffer.subarray(0, cut).toString("utf8");
        reader.buffer = reader.buffer.subarray(cut + 4);
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
        resolve({ status, head, key, socket, nextFrame: () => nextFrame(reader), bodyText: () => reader.buffer.toString("utf8") });
      }
      pumpFrames(reader);
    });
    socket.on("end", () => {
      reader.ended = true;
      for (const waiter of reader.waiters.splice(0)) waiter(null);
    });
    socket.on("error", reject);
  });
}

// Moves every complete frame of a raw reader to the waiting promises, or to its queue.
function pumpFrames(reader) {
  let read = parseServerFrame(reader.buffer);
  while (read !== null) {
    reader.buffer = reader.buffer.subarray(read.size);
    const waiter = reader.waiters.shift();
    if (waiter) waiter(read.frame);
    else reader.frames.push(read.frame);
    read = parseServerFrame(reader.buffer);
  }
}

// The next frame a raw reader receives, null once the server ended the socket.
function nextFrame(reader) {
  if (reader.frames.length > 0) return Promise.resolve(reader.frames.shift());
  if (reader.ended) return Promise.resolve(null);
  return new Promise((resolve) => reader.waiters.push(resolve));
}

// The close code a close frame carries.
function closeCode(frame) {
  assert.equal(frame?.opcode, 0x8, "expected a close frame");
  return frame.payload.readUInt16BE(0);
}

test("a terminal connects with the cookie and the exact origin: bytes flow both ways and a resize reaches the pty", async (t) => {
  const ctx = await termStudio(t);
  const id = await openOperator(ctx);
  const listed = JSON.parse((await send(ctx.port, { path: "/api/terminals", headers: ctx.headers })).body);
  assert.deepEqual(listed.terminals.map((terminal) => terminal.id), [id]);
  const child = ctx.fake.spawned[0];
  assert.equal(child.file, process.execPath);
  assert.deepEqual(child.args.slice(1), ["open", "alpha"]);
  child.emitData("before attach\r\n");
  const { socket, seen } = trackedTerm(ctx.port, id, ctx.headers);
  await once(socket, "open");
  await eventually(() => seen.text.includes("before attach"), "the scrollback replay");
  child.emitData("live bytes");
  await eventually(() => seen.text.includes("live bytes"), "live output");
  socket.send(new TextEncoder().encode("ls\r"));
  socket.send(JSON.stringify({ resize: { cols: 100, rows: 40 } }));
  await eventually(() => child.writes.includes("ls\r") && child.resizes.length === 1, "input and resize");
  assert.deepEqual(child.resizes, [{ cols: 100, rows: 40 }]);
  socket.close();
  await once(socket, "close");
});

test("a refused upgrade gets a short HTTP answer: no token, a foreign or missing origin, another path, an unknown id, a bad version", async (t) => {
  const ctx = await termStudio(t);
  const id = await openOperator(ctx);
  const cases = [
    { name: "no token", path: `/term/${id}`, headers: { Origin: ctx.studio.origin }, status: 401 },
    { name: "foreign origin", path: `/term/${id}`, headers: { Origin: "http://evil.example", Cookie: ctx.headers.cookie }, status: 403 },
    { name: "another loopback port", path: `/term/${id}`, headers: { Origin: "http://127.0.0.1:1", Cookie: ctx.headers.cookie }, status: 403 },
    { name: "no origin", path: `/term/${id}`, headers: { Cookie: ctx.headers.cookie }, status: 403 },
    { name: "the event stream", path: "/events", headers: { Origin: ctx.studio.origin, Cookie: ctx.headers.cookie }, status: 404 },
    { name: "mcp", path: "/mcp", headers: { Origin: ctx.studio.origin, Cookie: ctx.headers.cookie }, status: 404 },
    { name: "unknown id", path: `/term/${UNKNOWN_ID}`, headers: { Origin: ctx.studio.origin, Cookie: ctx.headers.cookie }, status: 404 },
    { name: "bad version", path: `/term/${id}`, headers: { Origin: ctx.studio.origin, Cookie: ctx.headers.cookie }, version: "8", status: 400 },
  ];
  for (const { name, status, ...request } of cases) {
    const answer = await rawUpgrade(ctx.port, request);
    assert.equal(answer.status, status, `${name}: ${answer.head}`);
    assert.match(answer.head, /Connection: close/, name);
    answer.socket.destroy();
  }
  assert.equal(ctx.fake.spawned[0].writes.length, 0);
});

test("a plain GET on /term is told it only accepts an upgrade", async (t) => {
  const ctx = await termStudio(t);
  const answer = await send(ctx.port, { path: `/term/${UNKNOWN_ID}`, headers: ctx.headers });
  assert.equal(answer.status, 426);
});

test("the handshake answers the RFC 6455 accept value, a ping gets its pong, and the CSP lets the page open its own ws origin", async (t) => {
  const ctx = await termStudio(t);
  const id = await openOperator(ctx);
  const answer = await rawUpgrade(ctx.port, { path: `/term/${id}`, headers: { Origin: ctx.studio.origin, Cookie: ctx.headers.cookie } });
  t.after(() => answer.socket.destroy());
  assert.equal(answer.status, 101);
  assert.match(answer.head, new RegExp(`Sec-WebSocket-Accept: ${acceptValue(answer.key).replace(/[+/]/g, "\\$&")}`));
  assert.doesNotMatch(answer.head, /Sec-WebSocket-Extensions/i);
  answer.socket.write(clientFrame(0x9, Buffer.from("are you there")));
  const pong = await answer.nextFrame();
  assert.equal(pong.opcode, 0xa);
  assert.equal(pong.payload.toString("utf8"), "are you there");
  const page = await send(ctx.port, { path: "/api/info", headers: ctx.headers });
  assert.match(page.headers["content-security-policy"], new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${ctx.port} ws://localhost:${ctx.port};`));
});

test("an unmasked frame closes with 1002 and a message over 1 MiB closes with 1009", async (t) => {
  const ctx = await termStudio(t);
  const id = await openOperator(ctx);
  const headers = { Origin: ctx.studio.origin, Cookie: ctx.headers.cookie };
  const unmasked = await rawUpgrade(ctx.port, { path: `/term/${id}`, headers });
  t.after(() => unmasked.socket.destroy());
  unmasked.socket.write(clientFrame(0x2, Buffer.from("x"), { masked: false }));
  assert.equal(closeCode(await unmasked.nextFrame()), 1002);
  const oversized = await rawUpgrade(ctx.port, { path: `/term/${id}`, headers });
  t.after(() => oversized.socket.destroy());
  oversized.socket.write(clientFrame(0x2, Buffer.alloc(0), { declared: MAX_MESSAGE_BYTES + 1 }));
  assert.equal(closeCode(await oversized.nextFrame()), 1009);
});

test("a bearer caller from the dev origin connects in API-only mode", async (t) => {
  const devOrigin = "http://127.0.0.1:5173";
  const ctx = await termStudio(t, { apiOnly: true, devOrigin });
  const id = await openOperator({ port: ctx.port, headers: { authorization: `Bearer ${STUDIO_TOKEN}` } });
  const { socket } = trackedTerm(ctx.port, id, { origin: devOrigin, authorization: `Bearer ${STUDIO_TOKEN}` });
  await once(socket, "open");
  socket.close();
  await once(socket, "close");
  const noOrigin = await rawUpgrade(ctx.port, { path: `/term/${id}`, headers: { Authorization: `Bearer ${STUDIO_TOKEN}` } });
  noOrigin.socket.destroy();
  assert.equal(noOrigin.status, 403);
});

test("a second attach closes the first with 4001 and gets the scrollback replayed", async (t) => {
  const ctx = await termStudio(t);
  const id = await openOperator(ctx);
  ctx.fake.spawned[0].emitData("history line");
  const first = trackedTerm(ctx.port, id, ctx.headers);
  await once(first.socket, "open");
  const second = trackedTerm(ctx.port, id, ctx.headers);
  await once(second.socket, "open");
  await eventually(() => first.seen.closed !== null, "the first socket to close");
  assert.deepEqual(first.seen.closed, { code: 4001, reason: "attached elsewhere" });
  await eventually(() => second.seen.text.includes("history line"), "the replay on reconnect");
  second.socket.close();
  await once(second.socket, "close");
});

test("a pty exit closes the socket with 1000 and its exit code", async (t) => {
  const ctx = await termStudio(t);
  const id = await openOperator(ctx);
  const { socket, seen } = trackedTerm(ctx.port, id, ctx.headers);
  await once(socket, "open");
  ctx.fake.spawned[0].emitExit(3);
  await eventually(() => seen.closed !== null, "the close");
  assert.deepEqual(seen.closed, { code: 1000, reason: "exited 3" });
});

test("DELETE ends a terminal: SIGHUP to its group, and it leaves the listing", async (t) => {
  const ctx = await termStudio(t);
  const id = await openOperator(ctx);
  const removed = await send(ctx.port, { method: "DELETE", path: `/api/terminals/${id}`, headers: ctx.headers });
  assert.equal(removed.status, 200, removed.body);
  assert.deepEqual(ctx.fake.signals[0], { pid: -ctx.fake.spawned[0].pid, signal: "SIGHUP" });
  const listed = JSON.parse((await send(ctx.port, { path: "/api/terminals", headers: ctx.headers })).body);
  assert.deepEqual(listed.terminals, []);
  const again = await send(ctx.port, { method: "DELETE", path: `/api/terminals/${id}`, headers: ctx.headers });
  assert.equal(again.status, 404);
  const extraKey = await send(ctx.port, { method: "POST", path: "/api/terminals", headers: { ...ctx.headers, "content-type": "application/json" }, body: JSON.stringify({ kind: "operator", project: "alpha", cwd: "/" }) });
  assert.equal(extraKey.status, 400);
  assert.match(extraKey.body, /never the request/);
});

test("closing the studio resolves with a connected socket: the client sees a close and the pty got SIGHUP", async (t) => {
  const ctx = await termStudio(t);
  const id = await openOperator(ctx);
  const { socket, seen } = trackedTerm(ctx.port, id, ctx.headers);
  await once(socket, "open");
  await ctx.studio.close();
  await eventually(() => seen.closed !== null, "the client close");
  assert.equal(seen.closed.code, 1001);
  assert.ok(ctx.fake.signals.some((entry) => entry.signal === "SIGHUP" && entry.pid === -ctx.fake.spawned[0].pid));
});

test("a peer that sends a close frame and never ends its side gets its socket destroyed, and the close handlers run", async (t) => {
  let connection = null;
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    connection = acceptUpgrade(req, socket, head);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const key = randomBytes(16).toString("base64");
  const client = connect({ port: server.address().port, host: "127.0.0.1", allowHalfOpen: true }, () => {
    client.write(`GET /x HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  t.after(() => client.destroy());
  client.on("error", () => {});
  let sawHead = false;
  client.on("data", (chunk) => {
    if (sawHead || !chunk.includes("\r\n\r\n")) return;
    sawHead = true;
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000, 0);
    client.write(clientFrame(0x8, code));
  });
  await eventually(() => connection !== null, "the upgrade");
  let closed = false;
  connection.onClose(() => {
    closed = true;
  });
  await sleep(2500);
  assert.equal(connection.socket.destroyed, true);
  assert.equal(closed, true);
});

test("a 1 MiB frame trickled one byte at a time is buffered in linear time", () => {
  const socket = new EventEmitter();
  Object.assign(socket, { destroyed: false, write: () => true, setNoDelay: () => {}, end: () => {} });
  socket.destroy = () => {
    socket.destroyed = true;
  };
  acceptUpgrade({ headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } }, socket, null);
  const header = Buffer.alloc(14);
  header[0] = 0x82;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES), 2);
  socket.emit("data", header);
  const one = Buffer.from([0]);
  const start = process.hrtime.bigint();
  for (let i = 0; i < 200_000; i += 1) socket.emit("data", one);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `200000 one-byte chunks blocked the loop for ${ms.toFixed(0)} ms`);
});
