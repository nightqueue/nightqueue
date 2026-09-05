import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { UserError } from "./errors.mjs";
import { configPath, homeDir, secretsPath } from "./paths.mjs";
import { emptyConfig, emptySecrets, normalizeConfig, normalizeSecrets } from "./schema.mjs";

const SECRETS_MODE = 0o600;
const HOME_MODE = 0o700;

// Escreve um arquivo de forma atomica, por arquivo temporario irmao mais rename.
export function writeFileAtomic(filePath, content, { mode } = {}) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, filePath);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Devolve os bits de permissao do caminho, ou null quando ele nao existe.
function modeOf(path) {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats ? stats.mode & 0o777 : null;
}

// Diz se o modo concede algum acesso a grupo ou a outros.
function isOpenToOthers(mode) {
  return mode !== null && (mode & 0o077) !== 0;
}

// Garante que o diretorio de configuracao exista em 0700, apertando-o tambem quando ja existia.
export function ensureHome(env = process.env) {
  const path = homeDir(env);
  const created = mkdirSync(path, { recursive: true, mode: HOME_MODE }) !== undefined;
  if (created || isOpenToOthers(modeOf(path))) chmodSync(path, HOME_MODE);
  return { path, created };
}

// Le um arquivo JSON, tratando ausencia como estrutura vazia e conteudo quebrado como erro de uso.
function readJsonFile(filePath, missing) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return missing;
    if (err instanceof SyntaxError) {
      throw new UserError(`\`${filePath}\` is not valid JSON: ${err.message} — fix or remove the file`);
    }
    throw new UserError(`cannot read \`${filePath}\`: ${err?.message ?? String(err)}`);
  }
}

// Serializa uma estrutura de configuracao para o disco.
function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Escreve uma linha de aviso no stderr.
function warnToStderr(line) {
  process.stderr.write(`${line}\n`);
}

// Avisa quando o arquivo de segredos esta mais aberto que 0600.
function warnOnOpenMode(filePath, warn) {
  const mode = modeOf(filePath);
  if (!isOpenToOthers(mode)) return;
  warn(`shift: warning: ${filePath} is mode 0${mode.toString(8).padStart(3, "0")}, expected 0600`);
}

// Carrega config.json, avisando sobre inconsistencia do arquivo sem reescreve-la.
export function loadConfig(env = process.env, { warn = warnToStderr } = {}) {
  const raw = readJsonFile(configPath(env), null);
  return raw === null ? emptyConfig() : normalizeConfig(raw, { warn });
}

// Grava config.json com escrita atomica, criando o diretorio quando falta.
export function saveConfig(config, env = process.env) {
  ensureHome(env);
  writeFileAtomic(configPath(env), serialize(config));
}

// Carrega secrets.json, avisando quando o modo do arquivo esta aberto demais.
export function loadSecrets(env = process.env, { warn = warnToStderr } = {}) {
  const filePath = secretsPath(env);
  warnOnOpenMode(filePath, warn);
  const raw = readJsonFile(filePath, null);
  return raw === null ? emptySecrets() : normalizeSecrets(raw);
}

// Grava secrets.json com escrita atomica e modo 0600.
export function saveSecrets(secrets, env = process.env) {
  ensureHome(env);
  writeFileAtomic(secretsPath(env), serialize(secrets), { mode: SECRETS_MODE });
}
