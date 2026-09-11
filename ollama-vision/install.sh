#!/usr/bin/env bash
# Instala o plugin ollama-vision para TODO o harness — todos os perfis (web,
# headless e os que vierem) e, portanto, todos os workspaces/repositórios.
#
#   ./install.sh
#   DSH_HOME=/caminho ./install.sh
#
#   $DSH_HOME/cordis.patch.yml                entry (camada do usuario: todo perfil)
#   $DSH_HOME/profiles/node_modules/          pacote 'dsh-ollama-vision', resolvivel
#     dsh-ollama-vision                       por qualquer perfil pelo nome
#   $DSH_HOME/profiles/web/plugins/           copia legada (nao referenciada) e removida
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
FARM="$DSH_DIR/profiles/node_modules"
DEST="$FARM/dsh-ollama-vision"
HOME_PATCH="$DSH_DIR/cordis.patch.yml"
WEB_PATCH="$DSH_DIR/profiles/web/cordis.patch.yml"

echo "origem : $SRC"
echo "destino: $DEST (todos os perfis)"
echo "entry  : $HOME_PATCH (camada do usuario)"

mkdir -p "$DEST"
install -m 0644 "$SRC/package.json" "$DEST/package.json"
install -m 0644 "$SRC/index.js" "$DEST/index.js"
install -m 0644 "$SRC/README.md" "$DEST/README.md" 2>/dev/null || true
echo "pacote copiado"

python3 - "$HOME_PATCH" "$WEB_PATCH" <<'PY'
import pathlib
import re
import sys


def localizar(texto, alvo):
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

bloco = (
    "- insert:\n"
    "    - id: ollama-vision\n"
    "      name: 'dsh-ollama-vision'\n"
    "      config:\n"
    "        model: gemma4:e2b\n"
    "        keepAlive: 30m\n"
    "        warmupOnStart: true\n"
)

patch_home.parent.mkdir(parents=True, exist_ok=True)
texto = patch_home.read_text() if patch_home.exists() else '[]'
novo, estado = gravar(texto, 'ollama-vision', bloco)
patch_home.write_text(novo)
print('camada do usuario: entrada ollama-vision ' + estado)

if patch_web.exists():
    texto = patch_web.read_text()
    novo, removido = remover(texto, 'ollama-vision')
    if removido:
        patch_web.write_text(novo)
        print('perfil web: entrada legada ollama-vision removida')
PY

echo
echo "Pronto. Reinicie ou recarregue o harness. Conferir depois:"
echo "  dsh --profile web --dump-config | grep -A3 ollama-vision"
