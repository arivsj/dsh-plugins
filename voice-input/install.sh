#!/usr/bin/env bash
# Instala o plugin voice-input para TODO o harness — todos os perfis (web,
# headless e os que vierem) e, portanto, todos os workspaces/repositórios.
#
#   ./install.sh                 # instala/atualiza
#   VOICE_PRELOAD=1 ./install.sh # tambem baixa o modelo do Whisper
#   DSH_HOME=/caminho ./install.sh
#
# Onde cada coisa vai:
#   $DSH_HOME/cordis.patch.yml            camada do USUARIO: a entry vive aqui e vale
#                                         para todo perfil (recomposicao a quente)
#   $DSH_HOME/profiles/node_modules/      farm compartilhado: o pacote fica aqui, entao
#     dsh-voice-input                     qualquer perfil resolve o nome 'dsh-voice-input'
#   $DSH_HOME/profiles/web/node_modules/  copia extra para o processo web JA em execucao
#     dsh-voice-input                     (o DSH guarda o caminho do bundle cliente em
#                                         cache por processo; a copia evita 404 ate o F5)
#   $DSH_HOME/profiles/web/cordis.patch.yml   entrada legada e removida (migracao)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
FARM="$DSH_DIR/profiles/node_modules"
WEB="$DSH_DIR/profiles/web"
HOME_PATCH="$DSH_DIR/cordis.patch.yml"
WEB_PATCH="$WEB/cordis.patch.yml"

echo "origem   : $SRC"
echo "pacote   : $FARM/dsh-voice-input  (todos os perfis)"
echo "copia web: $WEB/node_modules/dsh-voice-input (processo em execucao)"
echo "entry    : $HOME_PATCH (camada do usuario)"

for dest in "$FARM/dsh-voice-input" "$WEB/node_modules/dsh-voice-input"; do
  mkdir -p "$dest/lib"
  install -m 0644 "$SRC/package.json" "$dest/package.json"
  install -m 0644 "$SRC/lib/index.js" "$dest/lib/index.js"
  install -m 0644 "$SRC/lib/client.js" "$dest/lib/client.js"
done
echo "pacote copiado"

if [ ! -d "$SRC/vendor/faster_whisper" ]; then
  echo "instalando faster-whisper em $SRC/vendor (uma vez, ~200 MB)..."
  pip3 install --no-cache-dir --target "$SRC/vendor" faster-whisper
else
  echo "vendor ja presente: $SRC/vendor"
fi

mkdir -p "$SRC/models"

python3 - "$HOME_PATCH" "$WEB_PATCH" "$SRC" <<'PY'
import pathlib
import re
import sys


def localizar(texto, alvo):
    """Faixa do bloco '- insert:' que contem '- id: <alvo>' (linhas, inicio, fim)."""
    linhas = texto.splitlines()
    for indice, linha in enumerate(linhas):
        if linha.strip() == '- id: ' + alvo:
            inicio = None
            for volta in range(indice, -1, -1):
                if linhas[volta].rstrip() == '- insert:':
                    inicio = volta
                    break
            if inicio is None:
                return None
            fim = len(linhas)
            for avanco in range(indice + 1, len(linhas)):
                if linhas[avanco].rstrip() == '- insert:':
                    fim = avanco
                    break
            return linhas, inicio, fim
    return None


def remover(texto, alvo):
    faixa = localizar(texto, alvo)
    if faixa is None:
        return texto, False
    linhas, inicio, fim = faixa
    del linhas[inicio:fim]
    return '\n'.join(linhas).rstrip('\n') + '\n', True


def gravar(texto, alvo, bloco):
    faixa = localizar(texto, alvo)
    novas = bloco.rstrip('\n').split('\n')
    if faixa is not None:
        linhas, inicio, fim = faixa
        linhas[inicio:fim] = novas
        return '\n'.join(linhas).rstrip('\n') + '\n', 'atualizada'
    limpo = re.sub(r'(?m)^\s*#.*$', '', texto).strip()
    if limpo in ('[]', ''):
        return bloco, 'criada'
    return limpo.rstrip('\n') + '\n' + bloco, 'acrescentada'


patch_home = pathlib.Path(sys.argv[1])
patch_web = pathlib.Path(sys.argv[2])
src = sys.argv[3]

bloco = (
    "- insert:\n"
    "    - id: voice-input\n"
    "      name: 'dsh-voice-input'\n"
    "      config:\n"
    "        python: 'python3'\n"
    "        worker: '" + src + "/whisper_server.py'\n"
    "        vendor: '" + src + "/vendor'\n"
    "        modelDir: '" + src + "/models'\n"
    "        model: small\n"
    "        language: pt\n"
    "        warmupOnStart: true\n"
)

patch_home.parent.mkdir(parents=True, exist_ok=True)
texto = patch_home.read_text() if patch_home.exists() else '[]'
novo, estado = gravar(texto, 'voice-input', bloco)
patch_home.write_text(novo)
print('camada do usuario: entrada voice-input ' + estado)

if patch_web.exists():
    texto = patch_web.read_text()
    novo, removido = remover(texto, 'voice-input')
    if removido:
        patch_web.write_text(novo)
        print('perfil web: entrada legada voice-input removida')
PY

if [ "${VOICE_PRELOAD:-0}" = "1" ]; then
  echo "pre-carregando o modelo small (baixa do HuggingFace na primeira vez)..."
  printf '%s\n' '{"cmd":"shutdown"}' | PYTHONPATH="$SRC/vendor" python3 "$SRC/whisper_server.py" --model small --language pt --model-dir "$SRC/models" || true
fi

echo
echo "Pronto. A entry vive na camada do usuario, entao vale para todos os perfis e"
echo "todos os workspaces. Recarregue a pagina do harness (F5). Diagnostico:"
echo "  curl -s http://127.0.0.1:3080/voice-input/status"
