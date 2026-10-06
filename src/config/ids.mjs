const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;

export const ID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

let lastTime = -1;
let lastRandom = null;

// Encodes a non-negative integer as a fixed number of Crockford base32 characters.
function encodeTime(ms) {
  let value = ms;
  let text = "";
  for (let i = 0; i < TIME_CHARS; i += 1) {
    text = CROCKFORD[value % 32] + text;
    value = Math.floor(value / 32);
  }
  return text;
}

// Encodes 80 random bits as 16 Crockford base32 characters.
function encodeRandom(bytes) {
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let text = "";
  for (let i = 0; i < 16; i += 1) {
    text = CROCKFORD[Number(bits & 31n)] + text;
    bits >>= 5n;
  }
  return text;
}

// Adds one to the random part, so two ids of the same millisecond still sort in creation order.
function incremented(bytes) {
  const next = Uint8Array.from(bytes);
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i] < 255) {
      next[i] += 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error("newId: the random part overflowed inside one millisecond");
}

// A new monotonic ULID: 48 bits of milliseconds and 80 random bits, 26 Crockford base32 characters.
export function newId(now = Date.now()) {
  if (!Number.isInteger(now) || now < 0) throw new Error(`newId: invalid timestamp ${now}`);
  const time = Math.max(now, lastTime);
  lastRandom = time === lastTime ? incremented(lastRandom) : crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  lastTime = time;
  return encodeTime(time) + encodeRandom(lastRandom);
}

// Tells whether a value is an id this runtime hands out.
export function isId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

// The creation time in milliseconds an id carries in its first ten characters, or null for a value that is not an id.
export function idTime(id) {
  if (!isId(id)) return null;
  let ms = 0;
  for (const char of id.slice(0, TIME_CHARS)) ms = ms * 32 + CROCKFORD.indexOf(char);
  return ms;
}
