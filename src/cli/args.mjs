import { parseArgs } from "node:util";
import { UserError } from "../config/errors.mjs";

// Faz o parse estrito de argv, transformando opcao desconhecida em erro de uso.
export function parseCommand(args, options = {}) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    if (String(err?.code).startsWith("ERR_PARSE_ARGS_")) throw new UserError(err.message.split(". ")[0]);
    throw err;
  }
}

// Exige a quantidade de argumentos posicionais que o comando aceita.
export function checkArgs(positionals, { min = 0, max = min, usage }) {
  if (positionals.length < min) throw new UserError(`missing argument; usage: ${usage}`);
  if (positionals.length > max) throw new UserError(`unexpected argument \`${positionals[max]}\`; usage: ${usage}`);
  return positionals;
}
