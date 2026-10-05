#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
const API_PORT = "4747";
const DEV_ORIGIN = "http://127.0.0.1:5173";

// The entry script of the installed Vite, run with this same node; a checkout without `npm ci` is told so.
function viteBin() {
  const bin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
  if (!existsSync(bin)) throw new Error("vite is not installed; run `npm ci` first");
  return bin;
}

// Starts one child sharing this terminal, with the studio token and any extra settings in its environment.
function startChild(args, token, extraEnv = {}) {
  return spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...extraEnv, NIGHTQUEUE_STUDIO_TOKEN: token } });
}

// Runs the API-only studio and the Vite dev server side by side; Ctrl-C stops both, and either one exiting stops the other.
function main() {
  const token = randomBytes(24).toString("hex");
  const children = [
    startChild([CLI, "studio", "--api-only", "--port", API_PORT, "--token", token, "--dev-origin", DEV_ORIGIN], token, { NIGHTQUEUE_STUDIO_SPAWN_SELF: "1" }),
    startChild([viteBin(), "--config", "studio/vite.config.mts"], token),
  ];
  const stopAll = (signal = "SIGTERM") => {
    for (const child of children) if (child.exitCode === null) child.kill(signal);
  };
  process.on("SIGINT", () => stopAll("SIGINT"));
  process.on("SIGTERM", () => stopAll("SIGTERM"));
  for (const child of children) {
    child.on("error", (err) => {
      process.stderr.write(`studio:dev: ${err?.message ?? String(err)}\n`);
      stopAll();
    });
    child.on("exit", (code) => {
      if (process.exitCode === undefined) process.exitCode = code ?? 1;
      stopAll();
    });
  }
  process.stdout.write(`studio:dev: open ${DEV_ORIGIN}/ (API on 127.0.0.1:${API_PORT}, token passed by the Vite proxy)\n`);
}

main();
