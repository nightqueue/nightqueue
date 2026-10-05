import { createHash } from "node:crypto";
import { STATUS_CODES } from "node:http";

export const MAX_MESSAGE_BYTES = 1024 * 1024;

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const KEY_SHAPE = /^[A-Za-z0-9+/]{22}==$/;
const CLOSE_WAIT_MS = 10_000;
const TERMINATE_WAIT_MS = 1000;
const MAX_CONTROL_BYTES = 125;
const MAX_REASON_BYTES = 123;
const OPCODE = Object.freeze({ continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa });

// A frame or message the peer sent against RFC 6455, carrying the close code the connection ends with.
class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Answers an upgrade the studio refuses with a short HTTP response, then drops the socket.
export function refuseUpgrade(socket, status, message) {
  const body = JSON.stringify({ error: message });
  const head = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`,
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
  ];
  if (socket.destroyed) return;
  socket.end(`${head.join("\r\n")}\r\n\r\n${body}`, () => socket.destroy());
}

// The comma-separated tokens of a header, lowercased.
function headerTokens(req, name) {
  return String(req.headers[name] ?? "").toLowerCase().split(",").map((token) => token.trim());
}

// Why a request is not a valid RFC 6455 opening handshake, or null when it is one.
export function handshakeRefusal(req) {
  if (req.method !== "GET") return "a WebSocket handshake must be a GET";
  if (!headerTokens(req, "upgrade").includes("websocket")) return "the upgrade must ask for `websocket`";
  if (!headerTokens(req, "connection").includes("upgrade")) return "the `Connection` header must carry `upgrade`";
  if (req.headers["sec-websocket-version"] !== "13") return "only WebSocket version 13 is spoken here";
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !KEY_SHAPE.test(key) || Buffer.from(key, "base64").length !== 16) return "`Sec-WebSocket-Key` must be 16 bytes in base64";
  return null;
}

// The `Sec-WebSocket-Accept` value that answers a handshake key.
export function acceptValue(key) {
  return createHash("sha1").update(`${key}${ACCEPT_GUID}`).digest("base64");
}

// Encodes one unmasked server frame, the only kind a server sends.
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

// The payload of a close frame: the code, then the reason cut to what a control frame holds.
function closePayload(code, reason = "") {
  if (code === null || code === undefined) return Buffer.alloc(0);
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  let text = Buffer.from(String(reason), "utf8");
  if (text.length > MAX_REASON_BYTES) text = Buffer.from(text.subarray(0, MAX_REASON_BYTES).toString("utf8").replace(/�+$/, ""), "utf8");
  return Buffer.concat([payload, text]);
}

// The payload length a frame header declares and where its mask starts, or the bytes the header needs while it is incomplete.
function declaredLength(buffer) {
  const short = buffer[1] & 0x7f;
  if (short < 126) return { length: short, offset: 2 };
  if (short === 126) return buffer.length < 4 ? { need: 4 } : { length: buffer.readUInt16BE(2), offset: 4 };
  if (buffer.length < 10) return { need: 10 };
  const long = buffer.readBigUInt64BE(2);
  if (long > BigInt(MAX_MESSAGE_BYTES)) throw new ProtocolError(1009, "the frame is over the message limit");
  return { length: Number(long), offset: 10 };
}

// Reads one masked client frame off the front of the buffer, or the bytes it needs while it is incomplete; a frame against the protocol throws.
function readFrame(buffer) {
  if (buffer.length < 2) return { need: 2 };
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  if ((buffer[0] & 0x70) !== 0) throw new ProtocolError(1002, "reserved bits are set");
  if ((buffer[1] & 0x80) === 0) throw new ProtocolError(1002, "a client frame must be masked");
  const declared = declaredLength(buffer);
  if (declared.need !== undefined) return declared;
  const { length, offset } = declared;
  if (opcode >= 0x8 && (!fin || length > MAX_CONTROL_BYTES)) throw new ProtocolError(1002, "a control frame must be whole and at most 125 bytes");
  if (length > MAX_MESSAGE_BYTES) throw new ProtocolError(1009, "the frame is over the message limit");
  const end = offset + 4 + length;
  if (buffer.length < end) return { need: end };
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, end));
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
  return { frame: { fin, opcode, payload }, size: end };
}

// Refuses a text message that is not valid UTF-8.
function checkUtf8(payload) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new ProtocolError(1007, "a text message must be valid UTF-8");
  }
}

// Completes the handshake on an upgraded socket and answers the connection the terminal manager attaches to.
export function acceptUpgrade(req, socket, head) {
  socket.write(
    ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptValue(req.headers["sec-websocket-key"])}`].join("\r\n") + "\r\n\r\n",
  );
  socket.setNoDelay(true);
  return createConnection(socket, head);
}

// Wraps an upgraded socket in the framing, ping, close and size rules of RFC 6455.
function createConnection(socket, head) {
  const state = { socket, chunks: [], buffered: 0, need: 2, fragments: null, closeSent: false, failed: false, messageHandlers: [], closeHandlers: [], closeTimer: null };
  const connection = {
    socket,
    sendBinary: (data) => send(state, OPCODE.binary, Buffer.isBuffer(data) ? data : Buffer.from(data)),
    sendText: (text) => send(state, OPCODE.text, Buffer.from(String(text), "utf8")),
    close: (code = 1000, reason = "") => closeGracefully(state, code, reason),
    terminate: (code = 1001, reason = "") => terminate(state, code, reason),
    onMessage: (fn) => state.messageHandlers.push(fn),
    onClose: (fn) => state.closeHandlers.push(fn),
  };
  socket.on("data", (chunk) => onData(state, chunk));
  socket.on("end", () => socket.end());
  socket.on("error", () => socket.destroy());
  socket.on("close", () => onSocketClose(state));
  if (head && head.length > 0) queueMicrotask(() => onData(state, head));
  return connection;
}

// Writes one frame unless the connection is closing; answers false when the socket buffer is full.
function send(state, opcode, payload) {
  if (state.closeSent || state.socket.destroyed) return true;
  return state.socket.write(encodeFrame(opcode, payload));
}

// Sends a close frame once, the start of the closing handshake.
function sendClose(state, code, reason) {
  if (state.closeSent || state.socket.destroyed) return false;
  state.closeSent = true;
  state.socket.write(encodeFrame(OPCODE.close, closePayload(code, reason)));
  return true;
}

// Starts the closing handshake and drops the socket if the peer never answers it.
function closeGracefully(state, code, reason) {
  if (!sendClose(state, code, reason)) return;
  state.closeTimer = setTimeout(() => state.socket.destroy(), CLOSE_WAIT_MS);
  state.closeTimer.unref?.();
}

// Sends a close frame and ends the socket now, dropping it shortly after when the peer lingers.
function terminate(state, code, reason) {
  sendClose(state, code, reason);
  if (state.socket.destroyed) return;
  state.socket.end();
  setTimeout(() => state.socket.destroy(), TERMINATE_WAIT_MS).unref?.();
}

// Collects incoming bytes and parses frames only once the next one can be whole, so a trickled frame is copied once, not once per chunk.
function onData(state, chunk) {
  if (state.failed) return;
  state.chunks.push(chunk);
  state.buffered += chunk.length;
  if (state.buffered < state.need) return;
  const buffer = state.chunks.length === 1 ? state.chunks[0] : Buffer.concat(state.chunks, state.buffered);
  try {
    parseFrames(state, buffer);
  } catch (err) {
    fail(state, err instanceof ProtocolError ? err.code : 1011, err instanceof ProtocolError ? err.message : "the server failed on a message");
  }
}

// Handles every complete frame at the front of the buffer and keeps the incomplete rest with the bytes it needs.
function parseFrames(state, buffer) {
  let rest = buffer;
  for (;;) {
    const read = readFrame(rest);
    if (read.need !== undefined) {
      keepRemainder(state, rest, read.need);
      return;
    }
    rest = rest.subarray(read.size);
    onFrame(state, read.frame);
    if (state.failed || state.socket.destroyed) return;
  }
}

// Keeps the bytes of an incomplete frame as the single pending chunk.
function keepRemainder(state, rest, need) {
  state.chunks = rest.length > 0 ? [rest] : [];
  state.buffered = rest.length;
  state.need = need;
}

// Ends a connection that broke the protocol or failed on a message.
function fail(state, code, reason) {
  state.failed = true;
  keepRemainder(state, Buffer.alloc(0), 2);
  terminate(state, code, reason);
}

// Handles one frame: control frames at once, data frames assembled into messages.
function onFrame(state, { fin, opcode, payload }) {
  if (opcode === OPCODE.close) return onPeerClose(state, payload);
  if (opcode === OPCODE.ping) return send(state, OPCODE.pong, payload);
  if (opcode === OPCODE.pong) return;
  if (opcode === OPCODE.continuation) {
    if (!state.fragments) throw new ProtocolError(1002, "a continuation frame without a message");
  } else if (opcode === OPCODE.text || opcode === OPCODE.binary) {
    if (state.fragments) throw new ProtocolError(1002, "a new message inside a fragmented one");
    state.fragments = { binary: opcode === OPCODE.binary, parts: [], bytes: 0 };
  } else {
    throw new ProtocolError(1002, `unknown opcode ${opcode}`);
  }
  const message = state.fragments;
  message.bytes += payload.length;
  if (message.bytes > MAX_MESSAGE_BYTES) throw new ProtocolError(1009, "the message is over the limit");
  message.parts.push(payload);
  if (!fin) return;
  state.fragments = null;
  deliver(state, Buffer.concat(message.parts), message.binary);
}

// Hands a whole message to the handlers, a text one only once it is valid UTF-8.
function deliver(state, payload, binary) {
  if (state.closeSent) return;
  if (!binary) checkUtf8(payload);
  for (const fn of state.messageHandlers) fn(payload, binary);
}

// Answers the peer's close: echoes its code when this side had not closed yet, then ends the socket.
function onPeerClose(state, payload) {
  if (payload.length === 1) throw new ProtocolError(1002, "a close frame cannot carry a single byte");
  const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
  sendClose(state, code, "");
  state.failed = true;
  state.socket.end();
  clearTimeout(state.closeTimer);
  state.closeTimer = setTimeout(() => state.socket.destroy(), TERMINATE_WAIT_MS);
  state.closeTimer.unref?.();
}

// Runs the close handlers once the socket is gone.
function onSocketClose(state) {
  clearTimeout(state.closeTimer);
  const handlers = state.closeHandlers;
  state.closeHandlers = [];
  for (const fn of handlers) fn();
}
