import { readFileSync } from "node:fs";
import { UserError } from "../config/errors.mjs";

// Reads a JSON object written by the host, returning null when it is missing, unreadable or not an object.
export function readJsonOrNull(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Reads a JSON object this CLI is going to rewrite: broken content is a user error, never something to overwrite.
export function readJsonStrict(path, missing) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return missing;
    throw new UserError(`cannot read \`${path}\`: ${err?.message ?? String(err)}`);
  }
  if (!text.trim()) return missing;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UserError(`\`${path}\` is not valid JSON: ${err.message} - fix or move the file`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UserError(`\`${path}\` does not hold a JSON object - fix or move the file`);
  }
  return parsed;
}
