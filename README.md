# Plugins do DeepSeek Harness

Coleção de plugins **locais** criados para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH),
com tudo que é preciso para reinstalar em outra máquina ou depois de formatar o
computador: código, instaladores, verificação de ambiente e documentação de
dependências.

## Plugins

| plugin | o que faz | onde aparece no harness | metades | dependências pesadas |
|---|---|---|---|---|
| **[voice-input](voice-input/README.md)** | botão de microfone no composer: grava, transcreve em português com Whisper local e escreve o texto na caixa de entrada | barra interna do composer (slot `conversation.input.left`) | host (rotas HTTP) + cliente (bundle do navegador) | ffmpeg, faster-whisper (Python), modelo Whisper (75–464 MB) |
| **[ollama-vision](ollama-vision/README.md)** | dá visão a modelos que só entendem texto: tools `vision_ask` / `vision_warmup` respondem perguntas sobre imagens | ferramentas do agente (sem UI própria) | só host | servidor Ollama + modelo de visão `gemma4:e2b` (7,2 GB) |

Os dois são **aditivos**: não alteram nenhuma funcionalidade existente do
harness, só acrescentam uma entry no perfil web.

## Requisitos gerais

Versões realmente testadas nesta máquina (Ubuntu 22.04, kernel 6.x):

| componente | testado com | obrigatório para | observação |
|---|---|---|---|
| DSH | `0.1.0-rc.7` | os dois | precisa de slots de UI, rotas no webserver e plugins locais por perfil |
| Node.js | `v22.23.1` (npm 10.9.8) | os dois | é o runtime do próprio DSH |
| Python 3 | `3.10.12` | voice-input | só para o worker de transcrição |
| ffmpeg | `4.4.2` | voice-input | converte o áudio gravado para WAV 16 kHz mono |
| Ollama | `0.32.1` | ollama-vision | servidor em `127.0.0.1:11434` |
| Navegador | Chrome 153 / qualquer Chromium ou Firefox | voice-input | `getUserMedia` exige contexto seguro (`127.0.0.1` ou HTTPS) |

Detalhamento completo, incluindo tamanho de download e consumo de memória:
[DEPENDENCIAS.md](DEPENDENCIAS.md).

## Instalação rápida

```bash
git clone <url-deste-repo> ~/dsh-plugins     # ou copie a pasta inteira
cd ~/dsh-plugins

./doctor.sh          # o que já existe e o que falta (só lê, não altera nada)
./install-all.sh     # instala/atualiza todos os plugins no perfil web do DSH
```

Depois, **recarregue a página do harness (F5)**: o perfil aplica o
`cordis.patch.yml` a quente, então não é preciso reiniciar o `dsh web`
(reiniciar só quando o `package.json` de um plugin mudar).

Opções úteis:

```bash
./install-all.sh --list                  # lista os plugins do repositório
./install-all.sh --only voice-input      # instala um só
./install-all.sh --skip ollama-vision    # instala todos menos um
VOICE_PRELOAD=1 ./install-all.sh         # já baixa o modelo do Whisper (~464 MB)
DSH_HOME=/outro/caminho ./install-all.sh # outro perfil/home do DSH
```

## Estrutura

```
dsh-plugins/
├── README.md                    # este arquivo
├── DEPENDENCIAS.md              # matriz de dependências por plugin
├── install-all.sh               # instala todos (orquestra os install.sh de cada um)
├── doctor.sh                    # diagnóstico do ambiente e do perfil
├── docs/
│   ├── portabilidade.md         # backup, restauração e mudança de sistema
│   └── contrato-plugins-dsh.md  # como um plugin do DSH funciona (conhecimento acumulado)
├── voice-input/
│   ├── install.sh               # copia para o perfil + registra a entry + vendor Python
│   ├── lib/index.js             # metade host (rotas HTTP + worker)
│   ├── lib/client.js            # metade cliente (botão no composer)
│   ├── whisper_server.py        # worker faster-whisper (modelo residente)
│   ├── package.json             # pacote dual-face (exports `./client` + `dsh.client`)
│   ├── README.md                # uso, configuração, endpoints, limitações
│   ├── .dev/                    # self-tests (host, cliente, navegador via CDP)
│   ├── vendor/                  # (não versionado) dependências Python baixadas
│   └── models/                  # (não versionado) modelos Whisper baixados
└── ollama-vision/
    ├── install.sh               # copia para o perfil + registra a entry
    ├── index.js                 # plugin host-only (tools vision_ask / vision_warmup)
    ├── package.json
    ├── README.md
    └── .dev/                    # self-test
```

## Como cada plugin entra no harness

1. O `install.sh` do plugin **copia** o código para dentro do perfil web
   (`~/.dsh/profiles/web/`) — o harness executa essa cópia, não o repositório.
   - plugin **host-only** (ollama-vision): vai para `profiles/web/plugins/<nome>/`
     e a entry aponta para o caminho relativo do arquivo.
   - plugin **dual-face** (voice-input): precisa ser um **pacote** em
     `profiles/web/node_modules/` porque o navegador recebe a metade cliente
     resolvendo `require.resolve('<nome-do-pacote>/package.json')`.
2. O instalador acrescenta (ou atualiza) a entry em
   `~/.dsh/profiles/web/cordis.patch.yml`, que é o arquivo de patches do perfil.
3. O perfil recarrega esse arquivo a quente; o navegador só conhece o novo
   plugin depois de um **F5**.

O contrato completo (formato da entry, do bundle cliente, slots disponíveis,
rotas e armadilhas) está em [docs/contrato-plugins-dsh.md](docs/contrato-plugins-dsh.md).

## Verificação

```bash
./doctor.sh                                  # ambiente + estado do perfil
cd voice-input && node .dev/self-test.mjs    # transcrição de ponta a ponta (host + ffmpeg + Whisper)
node .dev/client-self-test.mjs               # lógica do botão sem navegador
node .dev/browser-probe.mjs                  # o botão existe no DOM? tem erro no console?
node .dev/browser-e2e.mjs                    # clique -> gravação -> POST -> texto na caixa de entrada
```

Com o harness no ar, as rotas do voice-input respondem direto:

```bash
curl -s http://127.0.0.1:3080/voice-input/status
curl -s -X POST --data-binary @fala.webm -H 'content-type: audio/webm' \
  http://127.0.0.1:3080/voice-input/transcribe
```

## O que não é versionado

`vendor/`, `models/`, `node_modules/`, `__pycache__/` e `.dev/tmp/` — são dependências
baixadas ou artefatos locais (veja o `.gitignore`). Cada `install.sh` recria tudo:
o vendor Python sai de `pip install --target vendor faster-whisper` e os modelos são
baixados do HuggingFace na primeira transcrição (ou com `VOICE_PRELOAD=1`).

## Portabilidade

Passo a passo para outra máquina, backup e troca de sistema operacional:
[docs/portabilidade.md](docs/portabilidade.md).

## Licença

MIT, como os próprios plugins.
