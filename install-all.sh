#!/usr/bin/env bash
# Instala (ou atualiza) TODOS os plugins deste repositorio no perfil web do DSH.
#
#   ./install-all.sh                 # instala tudo
#   ./install-all.sh --list          # so lista os plugins encontrados
#   ./install-all.sh --only voice-input
#   ./install-all.sh --skip ollama-vision
#   VOICE_PRELOAD=1 ./install-all.sh # tambem baixa o modelo do Whisper
#   DSH_HOME=/caminho ./install-all.sh
#
# Cada plugin tem o proprio install.sh (idempotente); este script so orquestra.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
ONLY=""
SKIP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list) printf '%s\n' "$(find "$SRC" -maxdepth 2 -name install.sh -not -path "$SRC/*/*/*" 2>/dev/null | sed "s|$SRC/||; s|/install.sh||" | sort)"; exit 0 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --skip) SKIP="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "opcao desconhecida: $1" >&2; exit 2 ;;
  esac
done

plugins=()
while IFS= read -r name; do
  [ -n "$name" ] || continue
  [ -n "$ONLY" ] && [ "$name" != "$ONLY" ] && continue
  [ -n "$SKIP" ] && [ "$name" = "$SKIP" ] && continue
  plugins+=("$name")
done < <(find "$SRC" -maxdepth 2 -name install.sh -not -path "$SRC/*/*/*" 2>/dev/null | sed "s|$SRC/||; s|/install.sh||" | sort)

if [ "${#plugins[@]}" -eq 0 ]; then
  echo "nenhum plugin para instalar (use --list para ver o que existe)" >&2
  exit 1
fi

echo "perfil alvo : $DSH_DIR/profiles/web"
echo "plugins     : ${plugins[*]}"
echo

for name in "${plugins[@]}"; do
  echo "=================== $name ==================="
  bash "$SRC/$name/install.sh"
  echo
done

echo "Concluido. Recarregue a pagina do harness (F5) e confira com ./doctor.sh"
