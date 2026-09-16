import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { UserError } from "../config/errors.mjs";

// Same path with every component that exists resolved through the filesystem - `resolve` is lexical, so a symlink anywhere on
// the path, not only on its last component, would otherwise point somewhere the caller never checked.
export function realPath(path) {
  const missing = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

// A path argument of a command, resolved against the working directory and refused when it leaves the directory the command may read.
export function pathUnder(root, value, { command, flag }) {
  const boundary = realPath(root);
  const target = realPath(resolve(root, value));
  if (target !== boundary && !target.startsWith(`${boundary}${sep}`)) {
    throw new UserError(`${command}: \`${flag}\` names ${target}, which is outside the working directory ${boundary}`);
  }
  return target;
}
