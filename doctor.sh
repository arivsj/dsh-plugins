#!/usr/bin/env bash
# Verifica os pre-requisitos dos plugins deste repositorio e o estado do perfil
# web do DSH. Somente leitura: nao instala nem altera nada.
#
#   ./doctor.sh
#   DSH_HOME=/caminho ./doctor.sh
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_DIR/profiles/web"
PATCH="$PROFILE/cordis.patch.yml"
WEB_URL="${DSH_WEB_URL:-http://127.0.0.1:3080}"

problems=0
ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$1"; problems=$((problems + 1)); }
warn() { printf '  \033[33m•\033[0m %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
section() { printf '\n%s\n' "$1"; }

section "Base do harness"
if have dsh; then ok "dsh: $(dsh --version 2>/dev/null | head -1)"; else bad "comando 'dsh' nao encontrado no PATH (npm i -g @deepseek-ai/dsh)"; fi
if [ -d "$PROFILE" ]; then ok "perfil web: $PROFILE"; else bad "perfil web ausente: $PROFILE (rode 'dsh web' uma vez)"; fi
if touch "$PROFILE/.doctor-write-test" 2>/dev/null; then
  rm -f "$PROFILE/.doctor-write-test"
  ok "perfil gravavel"
else
  warn "nao consegui escrever em $PROFILE — rode o install.sh no terminal normal do usuario (sandbox de escrita tambem bloqueia esta checagem)"
fi
if [ -f "$PATCH" ]; then ok "cordis.patch.yml presente"; else warn "cordis.patch.yml ainda nao existe (sera criado pelo install.sh)"; fi
if curl -s --max-time 3 -o /dev/null "$WEB_URL"; then ok "harness respondendo em $WEB_URL"; else warn "harness nao responde em $WEB_URL (rode 'dsh web' para testar as rotas)"; fi

section "voice-input (microfone + Whisper local)"
if have python3; then ok "python3: $(python3 -V 2>&1)"; else bad "python3 ausente"; fi
if have ffmpeg; then ok "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"; else bad "ffmpeg ausente (apt install ffmpeg)"; fi
if [ -d "$SRC/voice-input/vendor/faster_whisper" ]; then ok "dependencias Python em voice-input/vendor"; else bad "vendor ausente: rode ./voice-input/install.sh"; fi
if [ -d "$SRC/voice-input/models" ] && [ -n "$(ls -A "$SRC/voice-input/models" 2>/dev/null)" ]; then
  ok "modelos Whisper: $(du -sh "$SRC/voice-input/models" 2>/dev/null | cut -f1) em voice-input/models"
else
  warn "nenhum modelo Whisper baixado ainda (baixa sozinho na primeira transcricao)"
fi
if [ -d "$PROFILE/node_modules/dsh-voice-input" ]; then ok "pacote instalado no perfil"; else bad "pacote ausente em $PROFILE/node_modules/dsh-voice-input"; fi
if [ -f "$PATCH" ] && grep -q "voice-input" "$PATCH"; then ok "entry voice-input no cordis.patch.yml"; else bad "entry voice-input ausente no cordis.patch.yml"; fi
if curl -s --max-time 3 "$WEB_URL/voice-input/status" >/dev/null 2>&1; then ok "rota /voice-input/status respondendo"; else warn "rota ainda nao responde (harness parado ou plugin nao carregado)"; fi
if have google-chrome || have chromium || have firefox; then ok "navegador com microfone (getUserMedia exige 127.0.0.1 ou https)"; else warn "nenhum navegador encontrado para usar o botao"; fi

section "ollama-vision (visao local para modelos sem imagem)"
if have ollama; then ok "ollama: $(ollama --version 2>/dev/null | head -1)"; else bad "ollama ausente (https://ollama.com/download)"; fi
if curl -s --max-time 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then ok "servidor Ollama respondendo em 127.0.0.1:11434"; else warn "servidor Ollama parado (rode 'ollama serve')"; fi
if curl -s --max-time 5 http://127.0.0.1:11434/api/tags 2>/dev/null | grep -q "gemma4"; then
  ok "modelo de visao gemma4 presente no Ollama"
elif have ollama && ollama list 2>/dev/null | grep -q "gemma4"; then
  ok "modelo de visao gemma4 presente (ollama list)"
else
  warn "modelo de visao gemma4:e2b ausente (ollama pull gemma4:e2b, ~7,2 GB)"
fi
if [ -d "$PROFILE/plugins/ollama-vision" ]; then ok "plugin instalado no perfil"; else bad "copia ausente em $PROFILE/plugins/ollama-vision"; fi
if [ -f "$PATCH" ] && grep -q "ollama-vision" "$PATCH"; then ok "entry ollama-vision no cordis.patch.yml"; else bad "entry ollama-vision ausente no cordis.patch.yml"; fi

printf '\n'
if [ "$problems" -eq 0 ]; then
  echo "Tudo certo: nenhum problema bloqueante encontrado."
else
  echo "$problems problema(s) encontrado(s) — veja as linhas com ✘ acima."
fi
exit "$problems"
