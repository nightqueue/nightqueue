import { addFromArgs } from "./project.mjs";

// Registers the repository at the given path (default: current directory) as a project.
export async function run(argv, ctx) {
  await addFromArgs(argv, ctx, "shift init [path] [--org <name>] [--name <name>]");
}
