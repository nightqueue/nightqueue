import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Resolve o diretorio de configuracao, lendo o ambiente a cada chamada.
export function homeDir(env = process.env) {
  const raw = typeof env?.NIGHTSHIFT_HOME === "string" ? env.NIGHTSHIFT_HOME.trim() : "";
  return raw ? resolve(raw) : join(homedir(), ".nightshift");
}

// Caminho do arquivo de configuracao.
export function configPath(env = process.env) {
  return join(homeDir(env), "config.json");
}

// Caminho do arquivo de segredos.
export function secretsPath(env = process.env) {
  return join(homeDir(env), "secrets.json");
}
