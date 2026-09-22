# Dependências por plugin

Levantado na máquina de referência (Ubuntu 22.04, DSH `0.1.0-rc.7`). Serve para
responder "o que esse plugin precisa para funcionar?" antes de reinstalar em
outro lugar.

## Resumo

| | voice-input | ollama-vision |
|---|---|---|
| tipo | dual-face (host + navegador) | host-only |
| sistema | python3, ffmpeg, navegador | ollama (servidor) |
| runtime JS | serviços do DSH: `webServer` | serviços do DSH: `tools`, `systemPrompt` |
| pacotes JS | `@deepseek-ai/schemastery` (já vem no DSH) | `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools` (já vêm no DSH) |
| download extra | faster-whisper (~200 MB) + modelo Whisper (75–464 MB) | modelo de visão no Ollama (7,2 GB) |
| memória em uso | ~570 MB (modelo `small`) ou ~210 MB (`tiny`) | conforme o Ollama (VRAM/RAM) |
| rotas HTTP | `POST /voice-input/transcribe`, `GET /voice-input/status` | nenhuma |
| UI | botão no composer (slot `conversation.input.left`) | nenhuma (só tools) |
| funciona offline | sim, depois do modelo baixado | sim |

## Base compartilhada

Os dois plugins são carregados pelo **Loader do perfil web** do DSH
(`~/.dsh/profiles/web`) e usam apenas APIs públicas do harness:

| recurso do DSH | usado por | para quê |
|---|---|---|
| `@deepseek-ai/schemastery` | os dois | declarar o `Config` (schema + defaults) validado pelo Loader |
| `ctx.tools.register` + `@deepseek-ai/dsh-tools` | ollama-vision | registrar `vision_ask` / `vision_warmup` |
| `ctx.systemPrompt.section` | ollama-vision | ensinar o agente a usar a visão |
| `ctx.webServer.register` | voice-input | rotas HTTP de transcrição |
| `ctx.slots.register` (cliente) | voice-input | botão dentro do composer |
| `inputActions.setDraft` (cliente) | voice-input | escrever o texto transcrito na caixa de entrada |
| `react` (tabela do shell) | voice-input | componente do botão (sem build: `React.createElement`) |

Nenhum pacote npm é instalado para os plugins: tudo o que eles importam já
existe no DSH instalado. Os `node_modules` que aparecem dentro dos diretórios são
symlinks para `~/.dsh/profiles/node_modules`, usados só pelos self-tests.

## voice-input

### Sistema

| dependência | testado | por quê | como instalar |
|---|---|---|---|
| Python 3 (≥3.8) | 3.10.12 | worker do faster-whisper | `apt install python3` |
| ffmpeg | 4.4.2 | converte webm/ogg/opus/mp4 em WAV 16 kHz mono | `apt install ffmpeg` |
| navegador | Chrome 153 | `MediaRecorder` + `getUserMedia` | qualquer Chromium/Firefox |
| contexto seguro | — | `getUserMedia` só funciona em `127.0.0.1`, `localhost` ou HTTPS | acesse o harness por `http://127.0.0.1:3080` |
| pip3 | — | usado uma vez pelo `install.sh` | `apt install python3-pip` |

### Python (baixado para `voice-input/vendor/`, não versionado)

```bash
pip3 install --no-cache-dir --target vendor faster-whisper
```

Instalado na referência: `faster-whisper 1.2.1`, `ctranslate2 4.8.2`,
`numpy 2.2.6`, `av 17.1.0`, `tokenizers 0.23.2`, `huggingface-hub 1.31.0`,
`onnxruntime 1.23.2`, `sympy`, `tqdm`, `pyyaml`, `protobuf`, `flatbuffers`,
`coloredlogs`, `humanfriendly` — ~200 MB em disco.

Por que `--target` em vez de venv: em algumas distribuições o pacote
`python3-venv` não está instalado e `python3 -m venv` falha sem `ensurepip`. Com
`--target` o plugin roda `PYTHONPATH=vendor python3 whisper_server.py` e não
depende de venv nenhum.

### Modelos (baixados do HuggingFace para `voice-input/models/`, não versionados)

| modelo | repositório | disco | uso |
|---|---|---|---|
| `small` (padrão) | `Systran/faster-whisper-small` | 464 MB | bom equilíbrio em português |
| `tiny` | `Systran/faster-whisper-tiny` | 75 MB | mais rápido e mais fraco |
| `base`, `medium`, `large-v3` | `Systran/faster-whisper-*` | 145 MB – 3 GB | trocar `model:` no `cordis.patch.yml` |

O download acontece no primeiro carregamento (`warmupOnStart: true` faz isso no
boot do harness) e pode ser antecipado com `VOICE_PRELOAD=1 ./install.sh`.

### Rede e variáveis de ambiente

O worker define, antes de importar o faster-whisper:
`HF_HOME` e `HUGGINGFACE_HUB_CACHE` para `voice-input/models`,
`HF_HUB_DISABLE_XET=1` (o protocolo Xet do HuggingFace travava nesta rede),
`HF_HUB_ETAG_TIMEOUT=60` e `HF_HUB_DOWNLOAD_TIMEOUT=60` (rede instável),
`PYTHONUTF8=1` e `PYTHONIOENCODING=utf-8` (acentuação no prompt inicial).

### Memória

| situação | RSS observado |
|---|---|
| worker residente com `small` int8 | ~570 MB |
| worker residente com `tiny` int8 | ~210 MB |

Para não manter memória ocupada, use `warmupOnStart: false` — o modelo só carrega
na primeira transcrição (leva ~1–2 s a mais).

## ollama-vision

### Sistema

| dependência | testado | por quê |
|---|---|---|
| Ollama | 0.32.1 | roda o modelo de visão local |
| servidor Ollama | `127.0.0.1:11434` | `baseUrl` padrão da tool |
| modelo de visão | `gemma4:e2b` (7,2 GB) | responde sobre as imagens |

```bash
ollama pull gemma4:e2b
```

### Runtime

O plugin é host-only: a entry aponta para `./plugins/ollama-vision/index.js` e o
Loader resolve `@deepseek-ai/schemastery` e `@deepseek-ai/dsh-tools` a partir do
próprio DSH — não há nada para instalar em npm.

### Trocas e ajustes

`model`, `keepAlive`, `warmupOnStart`, `baseUrl`, `maxImages` e afins ficam no
`config:` da entry no `cordis.patch.yml`; a lista completa está no
[README do plugin](ollama-vision/README.md).

## O que é preciso levar para outra máquina

1. Este repositório (código + instaladores + docs). Nada de `vendor/`, `models/` ou
   `node_modules/` — tudo isso é recriado.
2. Dependências de sistema instaladas (tabela acima).
3. Modelos baixados de novo (Whisper via HuggingFace; `gemma4:e2b` via Ollama).
4. As entries em `~/.dsh/profiles/web/cordis.patch.yml` — o `install-all.sh` as
   recria; se você personalizou configs (modelo, portas), copie esse arquivo
   também (veja [docs/portabilidade.md](docs/portabilidade.md)).

## Onde a instalação vive (global por desenho)

| caminho | conteúdo | vale para |
|---|---|---|
| `~/.dsh/cordis.patch.yml` | as entries dos dois plugins (camada do usuário) | **todos os perfis e workspaces** |
| `~/.dsh/profiles/node_modules/dsh-voice-input/` | pacote dual-face (host + bundle cliente) | todos os perfis |
| `~/.dsh/profiles/node_modules/dsh-ollama-vision/` | plugin host-only | todos os perfis |
| `~/.dsh/profiles/web/node_modules/dsh-voice-input/` | cópia para o processo web em execução | perfil web |
| `~/dsh-plugins/` | código-fonte, instaladores, docs e modelos/vendor | — |

Nada é instalado dentro de um projeto/repositório: abrir outra pasta no harness
não muda nada, os plugins já estão lá.

## session-cost

| | session-cost |
|---|---|
| tipo | dual-face (host + navegador) |
| sistema | nenhum: sem Python, sem binario, sem modelo |
| runtime JS | servicos do DSH: sessionProjections (host) e slots (cliente) |
| pacotes JS | @deepseek-ai/schemastery (config) e zod (esquema da projecao), os dois ja vem no DSH |
| download extra | nenhum |
| memoria em uso | desprezivel: a projecao guarda totais, nao o log |
| rotas HTTP | nenhuma |

O preco por token nao e dependencia: e configuracao (veja o README do plugin).
