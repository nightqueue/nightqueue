import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/shift.mjs", import.meta.url));

// PoC (Grupo A / Hipotese unica): dois `shift org add` concorrentes contra o
// MESMO NIGHTSHIFT_HOME nao usam lock nem compare-and-swap em
// src/config/store.mjs (loadConfig -> mutacao em memoria -> saveConfig). Sob
// interleaving real, o segundo `rename` atomico vence e apaga silenciosamente
// a mutacao do primeiro, mesmo os dois processos saindo com exit 0.
//
// A janela de corrida entre dois `spawn` reais e inerentemente flaky, entao
// este PoC forca a janela: infla config.json com muitas orgs de enchimento
// antes da corrida, para que o parse/serialize (e portanto o intervalo entre
// leitura e escrita de cada processo) dure o suficiente para os dois
// processos se sobreporem de forma consistente. Medido nesta maquina: 30/30
// (100%) das tentativas com 3000 orgs de enchimento perderam uma das duas
// mutacoes (ver corpo do teste abaixo para o numero de tentativas rodado
// nesta execucao).

// Roda a CLI de forma sincrona, para os passos de setup que nao fazem parte da corrida.
function shiftSync(home, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, NIGHTSHIFT_HOME: home },
    encoding: "utf8",
  });
}

// Dispara a CLI como processo real e assincrono, para permitir corrida verdadeira entre dois.
function shiftAsync(home, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, NIGHTSHIFT_HOME: home },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolvePromise({ code, stderr }));
  });
}

// Cria um NIGHTSHIFT_HOME isolado, com config.json inflado para alargar a janela de corrida.
function makeRacingHome(fillerCount) {
  const home = mkdtempSync(join(tmpdir(), "nightshift-race-"));
  shiftSync(home, ["setup"]);
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  for (let index = 0; index < fillerCount; index += 1) {
    config.orgs[`filler-${index}`] = { displayName: `filler ${index}`, connections: { github: null } };
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return home;
}

// Roda uma unica rodada da corrida (dois `org add` concorrentes) e devolve o resultado observado.
async function runRace(fillerCount) {
  const home = makeRacingHome(fillerCount);
  try {
    const [a, b] = await Promise.all([
      shiftAsync(home, ["org", "add", "proc-a"]),
      shiftAsync(home, ["org", "add", "proc-b"]),
    ]);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    return {
      codeA: a.code,
      codeB: b.code,
      stderrA: a.stderr,
      stderrB: b.stderr,
      hasA: Object.hasOwn(config.orgs, "proc-a"),
      hasB: Object.hasOwn(config.orgs, "proc-b"),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("dois `shift org add` concorrentes nao perdem uma mutacao (lost update)", async () => {
  const ATTEMPTS = 8;
  const FILLER_COUNT = 3000;
  const results = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runRace(FILLER_COUNT));
  }

  const lost = results.filter((r) => !(r.hasA && r.hasB));
  if (lost.length > 0) {
    console.error(
      `lost update em ${lost.length}/${ATTEMPTS} tentativas (filler=${FILLER_COUNT}): ` +
        JSON.stringify(lost, null, 2),
    );
  }

  for (const [index, r] of results.entries()) {
    // Ambos os processos devem sair com sucesso: nenhum viu conflito, colisao ou erro.
    assert.equal(r.codeA, 0, `tentativa ${index}: processo A nao saiu 0 (stderr: ${r.stderrA})`);
    assert.equal(r.codeB, 0, `tentativa ${index}: processo B nao saiu 0 (stderr: ${r.stderrB})`);
    // Comportamento correto pela otica do operador: todo comando que retornou
    // sucesso esta de fato salvo -- nem "proc-a" nem "proc-b" pode ter sido
    // silenciosamente sobrescrito pelo outro `saveConfig`.
    assert.equal(r.hasA, true, `tentativa ${index}: org \`proc-a\` foi perdida (lost update)`);
    assert.equal(r.hasB, true, `tentativa ${index}: org \`proc-b\` foi perdida (lost update)`);
  }
});
