import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./errors.mjs";
import { homeDir } from "./paths.mjs";

const ACQUIRE_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 50;
const STALE_AFTER_MS = 300000;

// Caminho do diretorio que serve de lock de escrita do NIGHTSHIFT_HOME.
export function lockPath(env = process.env) {
  return `${homeDir(env)}.lock`;
}

// Espera um intervalo curto antes da proxima tentativa de aquisicao.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tenta criar o diretorio de lock, devolvendo false quando ele ja pertence a outro processo.
function tryCreate(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

// Descarta um lock velho o bastante para so poder ter sido abandonado por um processo morto.
function dropStale(path, staleAfterMs) {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats || Date.now() - stats.mtimeMs < staleAfterMs) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

// Adquire o lock, falhando com erro de uso quando outro shift o mantem alem do timeout.
async function acquire(path, { timeoutMs, staleAfterMs }) {
  const deadline = Date.now() + timeoutMs;
  let staleDropped = false;
  for (;;) {
    if (tryCreate(path)) return;
    if (!staleDropped && dropStale(path, staleAfterMs)) {
      staleDropped = true;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new UserError(
        `another shift command is writing to the configuration home; try again in a moment, or remove \`${path}\` if no other shift is running`,
      );
    }
    await delay(RETRY_INTERVAL_MS);
  }
}

// Executa a acao com exclusao entre processos sobre o mesmo NIGHTSHIFT_HOME.
export async function withLock(env, action, { timeoutMs = ACQUIRE_TIMEOUT_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
  const path = lockPath(env);
  await acquire(path, { timeoutMs, staleAfterMs });
  try {
    return await action();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
