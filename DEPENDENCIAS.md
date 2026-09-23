# Dependências por plugin

Levantado na máquina de referência (Ubuntu 22.04, DSH `0.1.0-rc.7`). Serve para
responder "o que esse plugin precisa para funcionar?" antes de reinstalar em
outro lugar.

## Resumo

> Eram dois plugins quando esta tabela nasceu, e ela era em colunas. Com cinco, uma
> linha por plugin se lê melhor; o detalhe de cada um vem nas seções abaixo.

| plugin | metades | sistema (fora do DSH) | baixa | memória residente | rotas HTTP | UI no harness |
|---|---|---|---|---|---|---|
| **voice-input** | host + cliente | python3, ffmpeg, navegador | faster-whisper (~200 MB) + modelo Whisper (75–464 MB) | ~570 MB (`small`) / ~210 MB (`tiny`) | `POST /voice-input/transcribe`, `GET /voice-input/status` | botão de microfone no composer |
| **ollama-vision** | host | Ollama + modelo de visão | `gemma4:e2b` (7,2 GB) | conforme o Ollama (VRAM/RAM) | nenhuma | nenhuma (só tools) |
| **session-cost** | host + cliente | nenhum | nenhum | desprezível | `GET`/`POST /session-cost/precos` | linha de custo no rodapé |
| **pockethound** | host | nenhum — mas o desk e o app vivem fora deste repositório | nenhum | desprezível | ponte de loopback, 11 rotas (ver abaixo) | nenhuma |
| **dev-rules** | host + cliente | nenhum | nenhum | desprezível | `GET /dev-rules/texto` | cartão em Configurações › Plugins |
## Base compartilhada

Os cinco são carregados pelo Loader do perfil e usam apenas APIs públicas do harness.
A entry de cada um vive na **camada do usuário** (`~/.dsh/cordis.patch.yml`), e é isso
que faz um plugin valer em todos os perfis (web, headless e os que vierem) e em todos
os workspaces:

| recurso do DSH | usado por | para quê |
|---|---|---|
| `@deepseek-ai/schemastery` | os cinco | declarar o `Config` (schema + defaults) validado pelo Loader |
| `ctx.webServer.register` | voice-input, session-cost, pockethound, dev-rules | rotas HTTP: microfone, preço, ponte do celular, texto das regras |
| `ctx.slots.register` (cliente) | voice-input, session-cost, dev-rules | botão no composer, linha de custo, cartão na tela de Configurações |
| `ctx.systemPrompt.section` | ollama-vision, dev-rules | ensinar o agente a usar a visão; pôr as regras do dev no prompt inicial |
| `ctx.settings.register` | dev-rules | guardar as escolhas do dev (`~/.dsh/settings.yaml`) |
| `ctx.sessionProjections` | session-cost, pockethound | publicar o preço por sessão; ler preço, contexto e plano do turno |
| `ctx.sessions` + `session/event` | pockethound | projetar a conversa para o celular |
| waterfall `approval/request` + seam `userQuestions` | pockethound | deixar o celular aprovar e responder |
| `ctx.tools.register` + `@deepseek-ai/dsh-tools` | ollama-vision, pockethound | `vision_ask`/`vision_warmup`, `pockethound_notify`/`pockethound_ask` |
| `react` (tabela do shell) | voice-input, session-cost, dev-rules | componentes do bundle cliente (sem build: `React.createElement`) |
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
2. Dependências de sistema (tabela acima). Só duas metades precisam de algo fora do
   DSH: o `voice-input` (python3, ffmpeg) e o `ollama-vision` (Ollama + modelo).
3. Modelos baixados de novo (Whisper via HuggingFace; `gemma4:e2b` via Ollama).
4. As entries em `~/.dsh/cordis.patch.yml` — o `install-all.sh` as recria; se você
   personalizou configs (modelo, portas, preços, regras), copie esse arquivo também
   (veja [docs/portabilidade.md](docs/portabilidade.md)).
5. Para o `pockethound`, os dois programas que conversam com ele vivem **fora** deste
   repositório: o **desk** (app Electron, no PC) e o **app PocketHound** (Android).

## Onde a instalação vive (global por desenho)

| caminho | conteúdo | vale para |
|---|---|---|
| `~/.dsh/cordis.patch.yml` | as entries dos cinco plugins (camada do usuário) | **todos os perfis e workspaces** |
| `~/.dsh/profiles/node_modules/dsh-<plugin>/` | o pacote de cada plugin (o farm compartilhado) | todos os perfis |
| `~/.dsh/profiles/web/node_modules/dsh-voice-input/` | cópia para o processo web em execução | perfil web |
| `~/.dsh/profiles/web/node_modules/dsh-session-cost/` | idem | perfil web |
| `~/.dsh/profiles/web/node_modules/dsh-dev-rules/` | idem | perfil web |
| `~/.dsh/profiles/web/plugins/ollama-vision/` | cópia do plugin host-only (a entry usa o pacote do farm) | perfil web |
| `~/.dsh/settings.yaml` | as escolhas do dev (seção `dev-rules`) | todos os perfis |
| `~/.dsh/session-cost/precos.json` | a tabela de preço que o dev atualizou (opcional) | todos os perfis |
| `~/.dsh/pockethound/bridge.json` | anúncio da ponte: porta e token, refeitos a cada boot | só o PC |
| `~/dsh-plugins/` | código-fonte, instaladores, docs, `vendor/` e `models/` | — |

Nada é instalado dentro de um projeto/repositório: abrir outra pasta no harness não muda
nada, os plugins já estão lá.

## session-cost

| | session-cost |
|---|---|
| tipo | dual-face (host + navegador) |
| sistema | nenhum: sem Python, sem binário, sem modelo |
| runtime JS | serviços do DSH: `sessionProjections` (host) e `slots` (cliente) |
| pacotes JS | `@deepseek-ai/schemastery` (config) e `zod` (esquema da projeção) — já vêm no DSH |
| download extra | nenhum |
| memória em uso | desprezível: a projeção guarda totais, não o log |
| rotas HTTP | `GET`/`POST /session-cost/precos` (a janelinha de preço) |
| estado | `~/.dsh/session-cost/precos.json`, criado quando você atualiza o preço pela tela |
| UI | linha de custo no rodapé do composer (slot `conversation.composer.dock`) |

O preço por token não é dependência: é configuração (veja o README do plugin).

## pockethound

| | pockethound |
|---|---|
| tipo | host (sem bundle de cliente — quem tem tela é o app) |
| sistema | nenhum: sem Python, sem binário, sem modelo |
| runtime JS | serviços do DSH: `sessions`, `sessionProjections`, `tools`; waterfall `approval/request` e o seam `userQuestions` |
| pacotes JS | `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm` — já vêm no DSH |
| download extra | nenhum |
| memória em uso | desprezível: um anel de 4000 quadros por sessão, para replay |
| rotas HTTP | ponte de loopback, porta dinâmica: `/health`, `/sessions`, `/workspaces`, `/session`, `/prompt`, `/cancel`, `/approval`, `/question`, `/pending`, `/presence`, `/stream` |
| estado | `~/.dsh/pockethound/bridge.json`: porta + token de 32 bytes, refeitos a cada boot |
| ferramentas | `pockethound_notify` (avisa no celular) e `pockethound_ask` (pergunta e espera) |

**O que ele não traz é a tela.** O **desk** (app Electron, repositório separado) fala com
a ponte, e o **app PocketHound** (Android, repositório separado) fala com o desk. Sem os
dois, o plugin fica publicado e ninguém aparece: o `/health` mostra `phones: 0`.

**O que ele lê das projeções:** `sessionCost` (o gasto em US$), `tokenUsage` e
`contextPressure` (o contexto) e `todos` (o plano do turno — o mesmo to-do que o
navegador desenha). Ler em vez de recalcular é o que faz o celular mostrar o MESMO
número do navegador.

## dev-rules

| | dev-rules |
|---|---|
| tipo | dual-face (host + cartão na tela de Configurações) |
| sistema | nenhum |
| runtime JS | host: `settings` (namespace `dev-rules`), `systemPrompt`, `webServer`; cliente: `settingsScope`, `slots` |
| pacotes JS | `@deepseek-ai/schemastery` — já vem no DSH |
| download extra | nenhum |
| memória em uso | desprezível |
| rotas HTTP | `GET /dev-rules/texto` (o texto que está indo para o prompt) |
| estado | `~/.dsh/settings.yaml`, seção `dev-rules`: as ESCOLHAS (quais valem) e as regras que o dev escreveu na tela |
| UI | Configurações › Plugins › Configuração de plugins |

O **catálogo** das regras (o texto de cada uma) não é estado do usuário: mora no código
(`REGRAS_DE_FABRICA`) ou no `config:` da entry, no `cordis.patch.yml`. A tela liga e
desliga; quem mantém o texto é o plugin.
