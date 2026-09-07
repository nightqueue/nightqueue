import { parseArgs } from "node:util";
import { UserError } from "../config/errors.mjs";

// Parses argv strictly, turning an unknown option into a usage error.
export function parseCommand(args, options = {}) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    if (String(err?.code).startsWith("ERR_PARSE_ARGS_")) throw new UserError(err.message.split(". ")[0]);
    throw err;
  }
}

// Turns a pair of opposite flags (`--x` and `--no-x`) into a tri-state: true, false, or undefined when the user said nothing.
export function flagChoice(values, name, usage) {
  if (values[name] === true && values[`no-${name}`] === true) {
    throw new UserError(`\`--${name}\` and \`--no-${name}\` cannot be used together; usage: ${usage}`);
  }
  if (values[`no-${name}`] === true) return false;
  return values[name] === true ? true : undefined;
}

// Requires the amount of positional arguments the command accepts.
export function checkArgs(positionals, { min = 0, max = min, usage }) {
  if (positionals.length < min) throw new UserError(`missing argument; usage: ${usage}`);
  if (positionals.length > max) throw new UserError(`unexpected argument \`${positionals[max]}\`; usage: ${usage}`);
  return positionals;
}
