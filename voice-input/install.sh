#!/usr/bin/env bash
# Instala o plugin voice-input no perfil web do DSH e o registra no cordis.patch.yml.
#
#   ./install.sh                 # instala/atualiza (baixa o vendor se faltar)
#   VOICE_PRELOAD=1 ./install.sh # instala e ja baixa o modelo do Whisper
#   DSH_HOME=/caminho ./install.sh
#
# A metade cliente precisa ser um PACOTE resolvivel pelo perfil (o DSH resolve
# o bundle por require.resolve('<nome>/package.json')), por isso a copia vai
# para <perfil>/node_modules/dsh-voice-input e a entry usa o nome do pacote.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_DIR/profiles/web"
DEST="$PROFILE/node_modules/dsh-voice-input"
PATCH="$PROFILE/cordis.patch.yml"

echo "origem : $SRC"
echo "destino: $DEST"

mkdir -p "$DEST/lib"
install -m 0644 "$SRC/package.json" "$DEST/package.json"
install -m 0644 "$SRC/lib/index.js" "$DEST/lib/index.js"
install -m 0644 "$SRC/lib/client.js" "$DEST/lib/client.js"
echo "pacote copiado"

if [ ! -d "$SRC/vendor/faster_whisper" ]; then
  echo "instalando faster-whisper em $SRC/vendor (uma vez, ~200 MB)..."
  pip3 install --no-cache-dir --target "$SRC/vendor" faster-whisper
else
  echo "vendor ja presente: $SRC/vendor"
fi

mkdir -p "$SRC/models"

python3 - "$PATCH" "$SRC" <<'PY'
import pathlib
import re
import sys

patch = pathlib.Path(sys.argv[1])
src = sys.argv[2]
patch.parent.mkdir(parents=True, exist_ok=True)
text = patch.read_text() if patch.exists() else '[]'

entry = (
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

entry_lines = entry.rstrip('\n').split('\n')

# A entry aponta para caminhos absolutos deste repositorio: se a pasta mudar de
# lugar, o bloco antigo precisa ser REESCRITO, nao apenas ignorado.
lines = text.splitlines()
start = None
end = len(lines)
for index, line in enumerate(lines):
    if line.strip() == '- id: voice-input':
        for back in range(index, -1, -1):
            if lines[back].rstrip() == '- insert:':
                start = back
                break
        for forward in range(index + 1, len(lines)):
            if lines[forward].rstrip() == '- insert:':
                end = forward
                break
        break

stripped = re.sub(r'(?m)^\s*#.*$', '', text).strip()
if start is not None:
    lines[start:end] = entry_lines
    patch.write_text('\n'.join(lines).rstrip('\n') + '\n')
    print('cordis.patch.yml: entrada voice-input atualizada (caminhos deste repositorio)')
elif stripped in ('[]', ''):
    patch.write_text(entry)
    print('cordis.patch.yml: entrada voice-input criada')
else:
    patch.write_text(stripped.rstrip() + '\n' + entry)
    print('cordis.patch.yml: entrada voice-input acrescentada')
PY

if [ "${VOICE_PRELOAD:-0}" = "1" ]; then
  echo "pre-carregando o modelo small (baixa do HuggingFace na primeira vez)..."
  printf '%s\n' '{"cmd":"shutdown"}' | PYTHONPATH="$SRC/vendor" python3 "$SRC/whisper_server.py" --model small --language pt --model-dir "$SRC/models" || true
fi

echo
echo "Pronto. Recarregue a pagina do harness (F5): o perfil aplica o cordis.patch.yml"
echo "a quente, entao nao e preciso reiniciar o dsh web (so se o package.json do"
echo "plugin mudar). Diagnostico:  curl -s http://127.0.0.1:3080/voice-input/status"
