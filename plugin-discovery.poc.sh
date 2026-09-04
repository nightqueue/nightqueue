#!/bin/bash
# PoC (QA-Provador, H1 grupo plugin-discovery): prova se o host Claude Code expõe os 6
# subagent_type do plugin nightshift sob o prefixo "nightshift:<agente>" quando o
# plugin é carregado via --plugin-dir. NÃO altera estado de git. NÃO edita source.
set -u
cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

EXPECTED=(
  "nightshift:architect"
  "nightshift:coder"
  "nightshift:explore"
  "nightshift:qa-guardian"
  "nightshift:triager"
  "nightshift:verifier"
)

PROMPT='Sem usar nenhuma tool: liste os nomes EXATOS de todos os subagent_type que a tool Agent/Task aceita, um por linha. Texto puro, sem explicacao.'

run_claude() {
  # $1 = CLAUDE_CONFIG_DIR a usar (vazio = herdar o real do usuário)
  local config_dir="$1"
  if [ -n "$config_dir" ]; then
    CLAUDE_CONFIG_DIR="$config_dir" timeout 180 claude --print --plugin-dir "$REPO_DIR/plugin" --max-turns 3 <<< "$PROMPT"
  else
    timeout 180 claude --print --plugin-dir "$REPO_DIR/plugin" --max-turns 3 <<< "$PROMPT"
  fi
}

echo "===== Tentativa 1: CLAUDE_CONFIG_DIR isolado/temporário =====" >&2
TMP_CONFIG="$(mktemp -d)"
OUT="$(run_claude "$TMP_CONFIG" 2>&1)"
EXIT_CODE=$?
rm -rf "$TMP_CONFIG"

ENV_FAIL_MARKERS='not logged in|no credential|authentication|Please run|API key|rate limit|ENOTFOUND|ECONNREFUSED|network'
USED_FALLBACK=0

if [ $EXIT_CODE -ne 0 ] || echo "$OUT" | grep -qiE "$ENV_FAIL_MARKERS"; then
  echo "Tentativa 1 falhou por possível motivo de ambiente (exit=$EXIT_CODE). Saída:" >&2
  echo "$OUT" >&2
  echo "===== Tentativa 2: herdando CLAUDE_CONFIG_DIR real do usuário =====" >&2
  OUT="$(run_claude "" 2>&1)"
  EXIT_CODE=$?
  USED_FALLBACK=1
fi

echo "----- saída bruta (exit=$EXIT_CODE, fallback_config=$USED_FALLBACK) -----" >&2
echo "$OUT" >&2
echo "----- fim da saída bruta -----" >&2

if [ $EXIT_CODE -ne 0 ] || echo "$OUT" | grep -qiE "$ENV_FAIL_MARKERS"; then
  echo "INCONCLUSIVA: ambas as invocações falharam por motivo de ambiente (exit=$EXIT_CODE)." >&2
  echo "Comando: claude --print --plugin-dir \"$REPO_DIR/plugin\" --max-turns 3 (isolado e depois com config real)" >&2
  exit 2
fi

MISSING=()
for name in "${EXPECTED[@]}"; do
  if ! echo "$OUT" | grep -qF "$name"; then
    MISSING+=("$name")
  fi
done

if [ ${#MISSING[@]} -eq 0 ]; then
  echo "PASSOU: as 6 subagent_type prefixadas apareceram na saída (fallback_config=$USED_FALLBACK)."
  exit 0
else
  echo "FALHOU: subagent_type ausentes da saída do host (fallback_config=$USED_FALLBACK):"
  printf '  - %s\n' "${MISSING[@]}"
  exit 1
fi
