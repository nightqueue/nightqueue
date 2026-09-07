import { createInterface } from "node:readline/promises";
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

// Asks one line, letting an answer win over the close readline emits right before it, and resolving to null when the input ends with no answer.
function askLine(rl, question) {
  return new Promise((resolve) => {
    rl.once("close", () => setImmediate(() => resolve(null)));
    rl.question(question).then(resolve, () => resolve(null));
  });
}

// Asks a yes/no question with echo: an empty answer means yes, anything else than y/yes (the end of the input included) means no.
export async function confirm({ stdin = process.stdin, stdout = process.stdout, question }) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await askLine(rl, question);
    if (answer === null) return false;
    const normalized = answer.trim().toLowerCase();
    return normalized === "" || normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
    stdin.pause?.();
  }
}
