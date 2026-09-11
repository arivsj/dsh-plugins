# voice-input — botão de microfone com Whisper local no DSH

Um clique no microfone abre o microfone do navegador, grava com animação (pulso
vermelho + barras de nível), transcreve **em português** com Whisper local
(faster-whisper) e **escreve o texto na caixa de entrada** do DSH, anexando ao
que já estava digitado.

## Como funciona

| camada | arquivo | papel |
|---|---|---|
| cliente (browser) | `lib/client.js` | bundle do module loader do DSH; registra o botão no slot `conversation.input.left` do composer, grava com `MediaRecorder` e chama `inputActions.setDraft()` com o texto transcrito |
| host (servidor DSH) | `lib/index.js` | registra as rotas `POST /voice-input/transcribe` e `GET /voice-input/status`, converte o áudio com ffmpeg e fala com o worker |
| motor | `whisper_server.py` | worker Python (faster-whisper) com o modelo residente; protocolo JSON por linha no stdin/stdout |

O plugin é um **pacote único** com duas metades: a entry do perfil
(`name: 'dsh-voice-input'`) resolve o host pelo `exports["."]` e o bundle do
navegador pelo `exports["./client"]` + `dsh.client` do `package.json`.

O áudio nunca sai da máquina: vai do navegador para o servidor local.

## Instalação

```bash
./install.sh                 # copia o pacote para o perfil e registra a entry
VOICE_PRELOAD=1 ./install.sh # idem, e já baixa o modelo do Whisper
```

O instalador:

1. copia `package.json` + `lib/` para `~/.dsh/profiles/web/node_modules/dsh-voice-input/`
   (o DSH resolve o bundle do cliente por `require.resolve('<nome>/package.json')`,
   por isso a metade cliente precisa ser um **pacote** em `node_modules`, e não
   um caminho relativo como o `ollama-vision`);
2. instala `faster-whisper` em `vendor/` (uma vez, ~200 MB) se faltar;
3. acrescenta a entry `voice-input` em `~/.dsh/profiles/web/cordis.patch.yml`
   apontando `worker`, `vendor` e `modelDir` para `$PWD` deste plugin.

O perfil recarrega `cordis.patch.yml` **a quente** (sem reiniciar o `dsh web`): a
metade host sobe na hora e o botão aparece **depois de um F5**, porque o
navegador só conhece o grafo de módulos que recebeu no boot. Reiniciar o
`dsh web` só é necessário se o `package.json` do plugin mudar (nome, exports,
`dsh.client`) — o DSH guarda esse metadado em cache por processo.

`install.sh` **copia** `package.json` e `lib/` para o perfil: o harness executa a
cópia instalada, não este diretório. Editar aqui e rodar `./install.sh` de novo
é o ciclo normal — depois da cópia, o HMR aplica a mudança sozinho (o botão é
trocado a quente ~500 ms depois; a metade host também, sem F5).

Depois do carregamento, conferir:

```bash
curl -s http://127.0.0.1:3080/voice-input/status | python3 -m json.tool
```

## Uso

- **Clique** no microfone: começa a gravar (pulso vermelho + barras de nível).
- **Clique de novo**: para a gravação e transcreve (spinner). O texto entra na
  caixa de entrada, depois do que já estava escrito.
- **Esc** (ou clique direito) durante a gravação: descarta.
- A primeira transcrição baixa o modelo (`small` ≈ 480 MB) e leva mais tempo;
  com `warmupOnStart: true` o plugin já começa a carregar quando o harness sobe.

## Configuração (entry em `cordis.patch.yml`)

| campo | padrão | descrição |
|---|---|---|
| `model` | `small` | `tiny` / `base` / `small` / `medium` / `large-v3` |
| `language` | `pt` | idioma forçado na transcrição |
| `initialPrompt` | texto em pt-BR | enviesa pontuação/acentuação |
| `device` / `computeType` | `cpu` / `int8` | para GPU: `cuda` / `float16` |
| `beamSize` | `5` | maior = melhor e mais lento |
| `python` | `python3` | interpretador do worker |
| `worker` / `vendor` / `modelDir` | caminhos deste plugin | script Python, dependências e cache do modelo |
| `route` / `statusRoute` | `/voice-input/transcribe`, `/voice-input/status` | rotas HTTP |
| `warmupOnStart` | `true` | carrega o modelo no boot do harness |
| `maxBytes` | 64 MB | limite do corpo do POST |
| `debug` | `false` | loga no stderr do harness |

Trocar de modelo: edite `model` no `cordis.patch.yml` (ou rode de novo o
`install.sh` depois de apagar a entry). Modelos maiores acertam mais em
português; `small` é o melhor equilíbrio, `tiny` é o mais rápido e o mais fraco.

## Endpoints

- `POST /voice-input/transcribe` — corpo = áudio cru (`audio/webm`, `audio/ogg`,
  `audio/wav`, `audio/mp4`); resposta `{ ok, text, language, duration, ms, model, bytes }`.
- `GET /voice-input/status` — estado do worker, modelo, tempo de load, caminhos.

Teste manual:

```bash
curl -s -X POST --data-binary @fala.webm -H 'content-type: audio/webm' \
  http://127.0.0.1:3080/voice-input/transcribe
```

## Self-tests

```bash
node .dev/self-test.mjs [audio] [modelo]   # host + ffmpeg + worker, sem harness
node .dev/client-self-test.mjs             # bundle do cliente com React/DOM falsos

# contra o harness rodando (Chrome headless via CDP)
node .dev/browser-probe.mjs                # o botão existe no DOM? há erro no console?
node .dev/browser-e2e.mjs [audio] [url]    # clique -> gravação -> POST -> texto na textarea
```

O `browser-e2e.mjs` troca `MediaRecorder`/`getUserMedia` por um gravador falso que
devolve um WAV de verdade, clica no botão duas vezes e confere o texto que chegou
na caixa de entrada — é a prova ponta a ponta navegador → rota → Whisper → composer.

## Repositório

Este plugin faz parte da coleção de plugins do DSH em [../README.md](../README.md):
dependências detalhadas em [../DEPENDENCIAS.md](../DEPENDENCIAS.md), portabilidade
e backup em [../docs/portabilidade.md](../docs/portabilidade.md) e o contrato técnico
dos plugins em [../docs/contrato-plugins-dsh.md](../docs/contrato-plugins-dsh.md).

## Limitações

- `getUserMedia` exige contexto seguro: `http://127.0.0.1:3080` e `localhost`
  funcionam; um IP de LAN em HTTP puro não.
- A transcrição é feita **depois** de parar a gravação (sem streaming parcial).
- Uma requisição por vez no worker (fila serial); o modelo fica residente na
  memória enquanto o harness estiver de pé.
- O botão só aparece com uma sessão aberta (o slot vive no card do composer).
- As rotas do plugin ficam **fora** da cerca de confiança do `/api`: se o harness
  for exposto em LAN (`--host` + `trustedHosts`), quem alcançar a porta pode
  postar áudio em `/voice-input/transcribe`. Em `127.0.0.1` (uso normal do
  `dsh web`) não há exposição.
- O modelo fica em `models/` dentro deste plugin (`small` ≈ 483 MB; `tiny` ≈ 75 MB
  se também for usado); apagar a pasta força novo download.
