#!/usr/bin/env bash
# Instala o plugin PocketHound para TODO o harness — todos os perfis (web,
# headless e os que vierem) e, portanto, todos os workspaces.
#
#   ./install.sh                 # instala/atualiza
#   ./install.sh --uninstall     # remove pacote e entry
#   DSH_HOME=/caminho ./install.sh
#
# Onde cada coisa vai:
#   ${DSH_HOME/cordis.patch.yml            camada do USUARIO: a entry vive aqui
#                                          e vale para todo perfil (recomposicao a quente)
#   ${DSH_HOME/profiles/node_modules/      farm compartilhado: qualquer perfil
#     dsh-pockethound                      resolve o nome 'dsh-pockethound'
#
# O plugin nao tem UI no navegador, entao nao existe 'dsh.client' nem copia para
# profiles/web/node_modules: um pacote host-only vive bem no farm.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
FARM="$DSH_DIR/profiles/node_modules"
HOME_PATCH="$DSH_DIR/cordis.patch.yml"
DEST="$FARM/dsh-pockethound"
ENTRY_ID="pockethound"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "opcao desconhecida: $1" >&2; exit 2 ;;
  esac
done

echo "origem : $SRC"
echo "pacote : $DEST"
echo "entry  : $HOME_PATCH  (camada do usuario, id '$ENTRY_ID')"
echo

if [ "$UNINSTALL" = "1" ]; then
  rm -rf "$DEST"
  echo "pacote removido"
  python3 - "$HOME_PATCH" "$ENTRY_ID" <<'PY'
import pathlib
import sys

patch = pathlib.Path(sys.argv[1])
alvo = sys.argv[2]
if not patch.exists():
    print("patch do usuario nao existe - nada a remover")
    raise SystemExit(0)

linhas = patch.read_text().splitlines()
inicio = fim = None
for indice, linha in enumerate(linhas):
    if linha.strip() == '- id: ' + alvo:
        for volta in range(indice, -1, -1):
            if linhas[volta].rstrip() == '- insert:':
                inicio = volta
                break
        if inicio is None:
            continue
        fim = len(linhas)
        for avanco in range(indice + 1, len(linhas)):
            if linhas[avanco].rstrip() == '- insert:':
                fim = avanco
                break
        break

if inicio is None:
    print("entry nao encontrada - nada a remover")
    raise SystemExit(0)

del linhas[inicio:fim]
restante = '\n'.join(linhas).strip()
patch.write_text((restante + '\n') if restante else '[]\n')
print("entry removida")
PY
  echo
  echo "Concluido. Reinicie o dsh (a remocao do pacote nao e aplicada a quente)."
  exit 0
fi

mkdir -p "$DEST/lib"
install -m 0644 "$SRC/package.json" "$DEST/package.json"
for arquivo in "$SRC"/lib/*.js; do
  install -m 0644 "$arquivo" "$DEST/lib/$(basename "$arquivo")"
done
echo "pacote copiado ($(ls -1 "$DEST/lib" | wc -l) modulos)"

python3 - "$HOME_PATCH" "$ENTRY_ID" <<'PY'
import pathlib
import re
import sys

patch = pathlib.Path(sys.argv[1])
alvo = sys.argv[2]

bloco = """- insert:
    - id: {alvo}
      name: 'dsh-pockethound'
      config:
        enabled: true
        claimApprovals: true
        claimQuestions: true
        approvalTimeoutMs: 90000
        coalesceMs: 40
        registerTools: true
""".format(alvo=alvo)


def localizar(linhas):
    """Faixa do bloco '- insert:' que contem '- id: <alvo>'."""
    for indice, linha in enumerate(linhas):
        if linha.strip() == '- id: ' + alvo:
            inicio = None
            for volta in range(indice, -1, -1):
                if linhas[volta].rstrip() == '- insert:':
                    inicio = volta
                    break
            if inicio is None:
                continue
            fim = len(linhas)
            for avanco in range(indice + 1, len(linhas)):
                if linhas[avanco].rstrip() == '- insert:':
                    fim = avanco
                    break
            return inicio, fim
    return None


texto = patch.read_text() if patch.exists() else ''
linhas = texto.splitlines()
novas = bloco.rstrip('\n').split('\n')

faixa = localizar(linhas)
if faixa is not None:
    inicio, fim = faixa
    linhas[inicio:fim] = novas
    patch.write_text('\n'.join(linhas).rstrip('\n') + '\n')
    print("entry atualizada")
else:
    limpo = re.sub(r'(?m)^\s*#.*$', '', texto).strip()
    if limpo in ('', '[]'):
        patch.write_text(bloco)
    else:
        patch.write_text(limpo.rstrip('\n') + '\n' + bloco)
    print("entry acrescentada")

patch.chmod(0o600)
PY

echo
echo "Conferindo a composicao (sem subir o harness):"
if command -v dsh >/dev/null 2>&1; then
  for perfil in web headless; do
    if dsh --profile "$perfil" --dump-config 2>/dev/null | grep -q "id: $ENTRY_ID"; then
      echo "  ok   perfil $perfil enxerga '$ENTRY_ID'"
    else
      echo "  ?    perfil $perfil nao listou '$ENTRY_ID'"
    fi
  done
else
  echo "  dsh nao esta no PATH - pulei a conferencia"
fi

echo
echo "Concluido. A entry e aplicada a quente; rode ../doctor.sh para o diagnostico."
