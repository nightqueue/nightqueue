import { UserError } from "../config/errors.mjs";

const CTRL_C = 0x03;
const BACKSPACE = new Set([0x7f, 0x08]);
const LINE_END = new Set([0x0d, 0x0a]);

// Consumes the whole stdin when it is not a terminal.
async function readFromStream(stdin) {
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data;
}

// Accumulates the typed bytes until enter, handling backspace and Ctrl-C.
function readRawLine(stdin) {
  return new Promise((resolve, reject) => {
    const bytes = [];
    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === CTRL_C) {
          stdin.off("data", onData);
          reject(new UserError("aborted"));
          return;
        }
        if (LINE_END.has(byte)) {
          stdin.off("data", onData);
          resolve(Buffer.from(bytes).toString("utf8"));
          return;
        }
        if (BACKSPACE.has(byte)) bytes.pop();
        else bytes.push(byte);
      }
    };
    stdin.on("data", onData);
  });
}

// Reads a line from the terminal in raw mode, without echoing what was typed.
async function readFromTty(stdin, stdout, prompt) {
  stdout.write(prompt);
  stdin.setRawMode(true);
  try {
    return await readRawLine(stdin);
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\n");
  }
}

// Reads a secret from stdin, without echo when the input is a terminal.
export async function readSecret({ stdin = process.stdin, stdout = process.stdout, prompt = "secret: " } = {}) {
  const raw = stdin.isTTY ? await readFromTty(stdin, stdout, prompt) : await readFromStream(stdin);
  const secret = raw.replace(/\r?\n$/, "");
  if (!secret) throw new UserError("no secret on stdin");
  return secret;
}
