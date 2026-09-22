#!/usr/bin/env bash
# Instala o plugin session-cost para TODO o harness — todos os perfis (web,
# headless e os que vierem) e, portanto, todos os workspaces.
#
#   ./install.sh
#   DSH_HOME=/caminho ./install.sh
#
# Onde cada coisa vai:
#   $DSH_HOME/cordis.patch.yml            camada do USUARIO: a entry vive aqui e vale
#                                         para todo perfil (recomposicao a quente)
#   $DSH_HOME/profiles/node_modules/      farm compartilhado: o pacote fica aqui, entao
#     dsh-session-cost                    qualquer perfil resolve o nome
#   $DSH_HOME/profiles/web/node_modules/  copia extra para o processo web JA em execucao
#     dsh-session-cost                    (o caminho do bundle cliente fica em cache por
#                                         processo; a copia evita 404 ate o F5)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
FARM="$DSH_DIR/profiles/node_modules"
WEB="$DSH_DIR/profiles/web"
HOME_PATCH="$DSH_DIR/cordis.patch.yml"
WEB_PATCH="$WEB/cordis.patch.yml"

echo "origem   : $SRC"
echo "pacote   : $FARM/dsh-session-cost  (todos os perfis)"
echo "copia web: $WEB/node_modules/dsh-session-cost (processo em execucao)"
echo "entry    : $HOME_PATCH (camada do usuario)"

for dest in "$FARM/dsh-session-cost" "$WEB/node_modules/dsh-session-cost"; do
  mkdir -p "$dest/lib"
  install -m 0644 "$SRC/package.json" "$dest/package.json"
  install -m 0644 "$SRC/lib/index.js" "$dest/lib/index.js"
  install -m 0644 "$SRC/lib/client.js" "$dest/lib/client.js"
done
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

# Sem config: os precos de fabrica ja sao os oficiais do deepseek-flash. Quem
# quiser mudar preco ou janela de pico edita esta entrada.
bloco = (
    '- insert:\n'
    "    - id: session-cost\n"
    "      name: 'dsh-session-cost'\n"
)

patch_home.parent.mkdir(parents=True, exist_ok=True)
texto = patch_home.read_text() if patch_home.exists() else '[]'
novo, estado = gravar(texto, 'session-cost', bloco)
patch_home.write_text(novo)
print('camada do usuario: entrada session-cost ' + estado)

if patch_web.exists():
    texto = patch_web.read_text()
    novo, removido = remover(texto, 'session-cost')
    if removido:
        patch_web.write_text(novo)
        print('perfil web: entrada legada session-cost removida')
PY

echo "Concluido. Recarregue a pagina do harness (F5) para ver a linha no composer."
