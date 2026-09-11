#!/usr/bin/env bash
# Instala o plugin ollama-vision no perfil web do DSH e o registra no cordis.patch.yml.
#
#   ./install.sh              # instala/atualiza
#   DSH_HOME=/caminho ./install.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_DIR/profiles/web"
DEST="$PROFILE/plugins/ollama-vision"
PATCH="$PROFILE/cordis.patch.yml"

echo "origem : $SRC"
echo "destino: $DEST"

mkdir -p "$DEST"
install -m 0644 "$SRC/index.js" "$DEST/index.js"
install -m 0644 "$SRC/package.json" "$DEST/package.json"
install -m 0644 "$SRC/README.md" "$DEST/README.md" 2>/dev/null || true
echo "arquivos copiados"

python3 - "$PATCH" <<'PY'
import pathlib, re, sys

patch = pathlib.Path(sys.argv[1])
patch.parent.mkdir(parents=True, exist_ok=True)
text = patch.read_text() if patch.exists() else '[]'

if 'ollama-vision' in text:
    print('cordis.patch.yml: entrada ollama-vision já presente')
    raise SystemExit(0)

entry = """- insert:
    - id: ollama-vision
      name: './plugins/ollama-vision/index.js'
      config:
        model: gemma4:e2b
        keepAlive: 30m
        warmupOnStart: true
"""

stripped = re.sub(r'(?m)^\s*#.*$', '', text).strip()
if stripped in ('[]', ''):
    patch.write_text(entry)
    print('cordis.patch.yml: entrada ollama-vision adicionada')
else:
    print('AVISO: cordis.patch.yml já tem conteúdo; adicione esta entrada à mão:')
    print(entry)
PY

echo
echo "Pronto. Reinicie o harness (dsh web) para carregar o plugin e conferir com:"
echo "  dsh --profile web --dump-config | grep -A3 ollama-vision"
