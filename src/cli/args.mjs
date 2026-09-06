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

// Requires the amount of positional arguments the command accepts.
export function checkArgs(positionals, { min = 0, max = min, usage }) {
  if (positionals.length < min) throw new UserError(`missing argument; usage: ${usage}`);
  if (positionals.length > max) throw new UserError(`unexpected argument \`${positionals[max]}\`; usage: ${usage}`);
  return positionals;
}
