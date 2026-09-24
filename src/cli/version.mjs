import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkArgs, parseCommand } from "./args.mjs";

// Reads the installed package version from package.json, at call time so it never drifts.
export function readVersion() {
  const path = fileURLToPath(new URL("../../package.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")).version;
}

// Runs `nightqueue version`: prints the installed version, with no arguments accepted.
export async function run(argv, ctx) {
  const { positionals } = parseCommand(argv, {});
  checkArgs(positionals, { max: 0, usage: "nightqueue version" });
  ctx.out(readVersion());
  return 0;
}
