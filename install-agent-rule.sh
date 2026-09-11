#!/usr/bin/env bash
# Escreve a regra dos plugins (docs/regra-plugins.md) no arquivo de instruções do
# agente QUE O HARNESS INSTALADO USA AGORA.
#
# O arquivo alvo não é chumbado: ele é descoberto a cada execução, lendo o
# próprio Harness (o plugin @deepseek-ai/dsh-agent-instructions declara o nome do
# arquivo global). Se o Harness mudar esse mecanismo, basta ajustar a descoberta
# aqui — o texto da regra continua o mesmo.
#
#   ./install-agent-rule.sh            # cria/atualiza o bloco da regra
#   ./install-agent-rule.sh --check    # só diz onde está e se o bloco existe
#   ./install-agent-rule.sh --print    # imprime o caminho alvo e sai
#   ./install-agent-rule.sh --dry-run  # mostra o que seria escrito, sem escrever
#   ./install-agent-rule.sh --remove   # remove o bloco da regra
#
#   AGENT_RULE_FILE=/caminho/AGENTS.md   # força um arquivo alvo
#   DSH_HOME=/caminho ./install-agent-rule.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
RULE_FILE="$SRC/docs/regra-plugins.md"
MODO="instalar"

case "${1:-}" in
  --check) MODO="checar" ;;
  --print) MODO="imprimir" ;;
  --dry-run) MODO="simular" ;;
  --remove) MODO="remover" ;;
  "") ;;
  *) echo "opcao desconhecida: $1" >&2; exit 2 ;;
esac

# --- descoberta do arquivo de instrucoes globais do Harness instalado ---------
descobrir_arquivo() {
  if [ -n "${AGENT_RULE_FILE:-}" ]; then
    printf '%s\n' "$AGENT_RULE_FILE"
    return
  fi
  local bin raiz fonte nome
  bin="$(command -v dsh 2>/dev/null || true)"
  if [ -n "$bin" ]; then
    raiz="$(cd "$(dirname "$(readlink -f "$bin")")/.." && pwd)"
    fonte="$raiz/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js"
    if [ -f "$fonte" ]; then
      nome="$(sed -n 's/.*USER_GLOBAL_FILE = "\([^"]*\)".*/\1/p' "$fonte" | head -1)"
      if [ -n "$nome" ]; then
        printf '%s\n' "$DSH_DIR/$nome"
        return
      fi
    fi
  fi
  printf '%s\n' "$DSH_DIR/AGENTS.md"   # padrao conhecido, se a descoberta falhar
}

ALVO="$(descobrir_arquivo)"

case "$MODO" in
  imprimir) printf '%s\n' "$ALVO"; exit 0 ;;
esac

if [ ! -f "$RULE_FILE" ]; then
  echo "regra nao encontrada: $RULE_FILE" >&2
  exit 1
fi

python3 - "$ALVO" "$RULE_FILE" "$MODO" <<'PY'
import pathlib
import sys

alvo = pathlib.Path(sys.argv[1])
regra = pathlib.Path(sys.argv[2])
modo = sys.argv[3]

INICIO = '<!-- dsh-plugins:regra:inicio -->'
FIM = '<!-- dsh-plugins:regra:fim -->'

texto_regra = regra.read_text()
partes = texto_regra.split('\n---\n', 1)
carga = (partes[1] if len(partes) > 1 else texto_regra).strip()
bloco = INICIO + '\n' + carga + '\n' + FIM + '\n'

texto = alvo.read_text() if alvo.exists() else ''
tem_bloco = INICIO in texto and FIM in texto

if modo == 'checar':
    if tem_bloco:
        print('regra presente em ' + str(alvo))
        raise SystemExit(0)
    print('regra AUSENTE em ' + str(alvo))
    raise SystemExit(1)

if modo == 'remover':
    if not tem_bloco:
        print('nada a remover em ' + str(alvo))
        raise SystemExit(0)
    i = texto.index(INICIO)
    j = texto.index(FIM) + len(FIM)
    novo = (texto[:i] + texto[j:]).strip('\n')
    alvo.write_text(novo + '\n' if novo else '')
    print('bloco da regra removido de ' + str(alvo))
    raise SystemExit(0)

if tem_bloco:
    i = texto.index(INICIO)
    j = texto.index(FIM) + len(FIM)
    novo = texto[:i] + bloco + texto[j:].lstrip('\n')
    acao = 'atualizada'
else:
    base = texto.rstrip('\n')
    novo = (base + '\n\n' if base else '') + bloco
    acao = 'acrescida' if base else 'criada'

if modo == 'simular':
    print('--- alvo: ' + str(alvo) + ' (' + acao + ', ' + str(len(novo.splitlines())) + ' linhas) ---')
    print(novo)
    raise SystemExit(0)

alvo.parent.mkdir(parents=True, exist_ok=True)
alvo.write_text(novo)
print('regra ' + acao + ' em ' + str(alvo) + ' (' + str(len(bloco.splitlines())) + ' linhas, resto do arquivo preservado)')
PY

if [ "$MODO" = "instalar" ]; then
  echo
  echo "O agente recebe essa regra no inicio de toda sessao, em qualquer projeto."
  echo "Reverte com: ./install-agent-rule.sh --remove"
fi
