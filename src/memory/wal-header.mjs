import { closeSync, openSync, readSync } from "node:fs";

const WAL_HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 24;
const WAL_MAGIC = 0x377f0682;
const USER_VERSION_OFFSET = 60;
const MIN_PAGE_SIZE = 512;
const MAX_PAGE_SIZE = 65536;

// Reads up to `length` bytes of a file at `position` into the buffer, answering how many were read.
function readAt(fd, buffer, position) {
  return readSync(fd, buffer, 0, buffer.length, position);
}

// Adds the 32-bit word pairs of a buffer to a running SQLite WAL checksum, in the byte order the log declares.
function addChecksum(buffer, bigEndian, [first, second]) {
  let s0 = first;
  let s1 = second;
  for (let i = 0; i + 8 <= buffer.length; i += 8) {
    s0 = (s0 + (bigEndian ? buffer.readUInt32BE(i) : buffer.readUInt32LE(i)) + s1) >>> 0;
    s1 = (s1 + (bigEndian ? buffer.readUInt32BE(i + 4) : buffer.readUInt32LE(i + 4)) + s0) >>> 0;
  }
  return [s0, s1];
}

// Tells whether a page size read from a WAL header is one SQLite can write.
function isPageSize(size) {
  return size >= MIN_PAGE_SIZE && size <= MAX_PAGE_SIZE && (size & (size - 1)) === 0;
}

// The layout a WAL header declares (`{ pageSize, bigEndian, salt, checksum }`), or null for a header that is not a valid one.
function walLayout(header) {
  if (header.length < WAL_HEADER_BYTES || (header.readUInt32BE(0) & ~1) >>> 0 !== WAL_MAGIC) return null;
  const bigEndian = (header.readUInt32BE(0) & 1) === 1;
  const raw = header.readUInt32BE(8);
  const pageSize = raw === 1 ? MAX_PAGE_SIZE : raw;
  const checksum = addChecksum(header.subarray(0, 24), bigEndian, [0, 0]);
  if (!isPageSize(pageSize) || checksum[0] !== header.readUInt32BE(24) || checksum[1] !== header.readUInt32BE(28)) return null;
  return { pageSize, bigEndian, salt: header.subarray(16, 24), checksum };
}

// Tells whether a frame belongs to the log's current generation and continues its checksum chain, answering the chain's next value or null.
function chainedChecksum(frame, layout, previous) {
  if (!frame.subarray(8, 16).equals(layout.salt)) return null;
  const checksum = addChecksum(frame.subarray(FRAME_HEADER_BYTES), layout.bigEndian, addChecksum(frame.subarray(0, 8), layout.bigEndian, previous));
  if (checksum[0] !== frame.readUInt32BE(16) || checksum[1] !== frame.readUInt32BE(20)) return null;
  return checksum;
}

// Walks the valid frames of a log, answering the user_version of the last page 1 a committed transaction wrote, or null when none did.
function scanFrames(fd, layout) {
  const frame = Buffer.alloc(FRAME_HEADER_BYTES + layout.pageSize);
  let checksum = layout.checksum;
  let uncommitted = null;
  let committed = null;
  for (let offset = WAL_HEADER_BYTES; readAt(fd, frame, offset) === frame.length; offset += frame.length) {
    checksum = chainedChecksum(frame, layout, checksum);
    if (checksum === null) break;
    if (frame.readUInt32BE(0) === 1) uncommitted = frame.readUInt32BE(FRAME_HEADER_BYTES + USER_VERSION_OFFSET);
    if (frame.readUInt32BE(4) === 0) continue;
    committed = uncommitted ?? committed;
    uncommitted = null;
  }
  return committed;
}

// The user_version the last committed transaction of a write-ahead log stamped on page 1, read with a plain file descriptor SQLite never sees; null when the log has no committed page 1 or is not a valid log.
export function walUserVersion(walPath) {
  const fd = openSync(walPath, "r");
  try {
    const header = Buffer.alloc(WAL_HEADER_BYTES);
    const layout = walLayout(header.subarray(0, readAt(fd, header, 0)));
    return layout === null ? null : scanFrames(fd, layout);
  } finally {
    closeSync(fd);
  }
}
