import { addFromArgs } from "./project.mjs";

// Registra o repositorio do path informado (default: diretorio atual) como projeto.
export async function run(argv, ctx) {
  await addFromArgs(argv, ctx, "shift init [path] [--org <name>] [--name <name>]");
}
