import { readFileSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { checkArgs, fileList, parseCommand } from "./args.mjs";
import { pathUnder } from "./paths.mjs";

export const SECRETS_SWEEP_USAGE = "nightshift run secrets-sweep --files <list>";

const TERMS = new Set([
  "token", "bearer", "authorization", "auth", "password", "passwd", "pwd",
  "secret", "key", "apikey", "cookie", "credential",
]);
const SINK_RE = /\b(?:console\.\w+|logger\.\w+|logging\.\w+|log\.\w+|Log\.\w+|fmt\.(?:Fprintf|Fprintln|Fprint|Printf|Println|Print)|System\.out\.print\w*|NSLog|printf|println!?|print_r|print|var_dump|puts)\s*\(/g;
const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const MAX_LINE_CHARS = 200;
const MAX_DEFS = 3;
const MAX_ARG_CHARS = 2000;

// Blanks one character unless it is a newline, so a literal never shifts the line numbers the report prints.
function blankAt(chars, index) {
  if (index < chars.length && chars[index] !== "\n") chars[index] = " ";
}

// Index right after the `}` that closes a template interpolation, whose content is left as code.
function skipInterpolation(chars, start) {
  let depth = 1;
  let i = start;
  while (i < chars.length && depth > 0) {
    if (chars[i] === "{") depth += 1;
    else if (chars[i] === "}") depth -= 1;
    i += 1;
  }
  return i;
}

// Blanks one literal from its opening quote, keeping `${...}` interpolations; an unterminated quote stops at the end of its line.
function blankLiteral(chars, start, quote) {
  let i = start + 1;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === quote) return i + 1;
    if (ch === "\n" && quote !== "`") return i;
    if (ch === "\\") {
      blankAt(chars, i);
      blankAt(chars, i + 1);
      i += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && chars[i + 1] === "{") {
      i = skipInterpolation(chars, i + 2);
      continue;
    }
    blankAt(chars, i);
    i += 1;
  }
  return i;
}

// Same text with every string literal blanked out, so the argument scan reads variables and not the words of a message.
function blankStrings(text) {
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "'" || ch === '"' || ch === "`") i = blankLiteral(chars, i, ch);
    else i += 1;
  }
  return chars.join("");
}

// Offset each line starts at, so a match index becomes a line number without re-scanning the file.
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

// Line number, 1-based, an offset falls on.
function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

// Text of one call's argument list, from its open parenthesis to the one that closes it.
function argText(code, openIndex) {
  let depth = 0;
  const limit = Math.min(code.length, openIndex + MAX_ARG_CHARS);
  for (let i = openIndex; i < limit; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex + 1, i);
    }
  }
  return code.slice(openIndex + 1, limit);
}

// Lower-case parts of one identifier, so `apiKey` carries `key` while `keyboard` carries only itself.
function identifierParts(word) {
  return word
    .replace(/[_$]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, (_match, left, right) => `${left} ${right}`)
    .replace(/([A-Z]+)([A-Z][a-z])/g, (_match, left, right) => `${left} ${right}`)
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

// Whether a part is one of the terms, its plural included.
function isSecretPart(part) {
  return TERMS.has(part) || (part.endsWith("s") && TERMS.has(part.slice(0, -1)));
}

// Whether a piece of text names a secret term as a whole identifier part — never as a fragment of a longer word.
function hasSecretTerm(text) {
  for (const [word] of String(text).matchAll(WORD_RE)) {
    if (identifierParts(word).some(isSecretPart)) return true;
  }
  return false;
}

// Identifiers an argument list references, in order and without repeats.
function argIdentifiers(text) {
  return [...new Set([...text.matchAll(WORD_RE)].map(([word]) => word))];
}

// Same string with every regular-expression metacharacter escaped.
function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);
}

// Lines that assign the identifier AND name a secret term — the second hop, which is what catches a logged variable built from a header.
function secretDefinitions(lines, name, callLine) {
  const pattern = new RegExp(`(?:^|[^\\w$.])${escapeForRegex(name)}\\s*(?:=[^=]|=$|:=|\\+=|:\\s)`);
  const found = [];
  for (let i = 0; i < lines.length && found.length < MAX_DEFS; i += 1) {
    if (i + 1 === callLine) continue;
    if (pattern.test(lines[i]) && hasSecretTerm(lines[i])) found.push({ line: i + 1, text: lines[i] });
  }
  return found;
}

// Candidate log calls of one file: every sink whose arguments name a secret term, directly or through the line that defines the variable.
function scanSource(text) {
  const lines = text.split("\n");
  const code = blankStrings(text);
  const starts = lineStarts(text);
  const candidates = [];
  for (const match of code.matchAll(SINK_RE)) {
    const line = lineAt(starts, match.index);
    const names = argIdentifiers(argText(code, match.index + match[0].length - 1));
    const direct = names.some((name) => hasSecretTerm(name));
    const defs = direct ? [] : names.flatMap((name) => secretDefinitions(lines, name, line)).slice(0, MAX_DEFS);
    if (direct || defs.length) candidates.push({ line, text: lines[line - 1] ?? "", defs });
  }
  return candidates;
}

// Reads one file for the sweep: an unreadable or binary file is a reported outcome, never a crash.
function readSource(path) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch (err) {
    return { error: `cannot read ${path} (${err?.message ?? String(err)})` };
  }
  if (raw.includes(0)) return { error: `binary file skipped: ${path}` };
  return { text: raw.toString("utf8") };
}

// One source line as the report prints it: trimmed and capped, so a minified file never floods the block.
function display(text) {
  const trimmed = String(text).trim();
  return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed;
}

// Prints one candidate: the log call and, under it, the definition lines that carry the term.
function printCandidate(ctx, file, candidate) {
  ctx.out(`${file}:${candidate.line}: ${display(candidate.text)}`);
  for (const def of candidate.defs) ctx.out(`    def ${file}:${def.line}: ${display(def.text)}`);
}

// Prints the log lines whose arguments reference a secret-looking value; the QA interprets them, this command never judges.
export function runSecretsSweep(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { files: { type: "string", multiple: true } });
  checkArgs(positionals, { max: 0, usage: SECRETS_SWEEP_USAGE });
  if (values.files === undefined) throw new UserError(`missing \`--files\`; usage: ${SECRETS_SWEEP_USAGE}`);
  const files = fileList(values);
  if (!files.length) ctx.err("nightshift run secrets-sweep: the `--files` list is empty; nothing to sweep");
  let candidates = 0;
  let scanned = 0;
  for (const file of files) {
    const source = readSource(pathUnder(ctx.cwd, file, { command: "nightshift run secrets-sweep", flag: "--files" }));
    if (source.error) {
      ctx.err(`nightshift run secrets-sweep: ${source.error}`);
      continue;
    }
    scanned += 1;
    for (const candidate of scanSource(source.text)) {
      printCandidate(ctx, file, candidate);
      candidates += 1;
    }
  }
  ctx.out(`secrets-sweep: ${candidates} candidates in ${scanned} files`);
  return 0;
}
