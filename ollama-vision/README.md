# ollama-vision — olhos locais para modelos que não veem imagens

Plugin do **DeepSeek Harness (DSH)** que dá visão ao modelo principal usando o
**Ollama local** (Gemma). Quando o agente precisa saber o que tem numa imagem —
print, foto, diagrama, gráfico, página escaneada, imagem colada no chat — ele
chama uma tool que manda a imagem para o Ollama e recebe a resposta **em texto**.

Registra duas tools:

| Tool | Para quê |
|------|----------|
| `vision_ask` | Pergunta sobre uma ou mais imagens; devolve a resposta do modelo de visão em texto. |
| `vision_warmup` | Mostra o estado (modelo residente? versão do Ollama? anexos disponíveis?) e, se quiser, já inicia o carregamento do modelo. |

Também injeta uma seção no system prompt avisando o modelo principal de que ele
não enxerga imagens e deve usar `vision_ask`.

## O problema do carregamento ("alguns minutinhos")

Modelo grande frio demora para entrar na memória (o `gemma4:e2b` levou ~39 s
aqui; o `gemma4:e4b` leva mais). O plugin foi feito em volta disso:

1. **Pré-carrega ao subir o harness** (`warmupOnStart: true`, com 2,5 s de
   atraso) — quando você pedir uma imagem, o modelo já está quente.
2. **Mantém residente** com `keep_alive` (`30m` por padrão) — a segunda
   pergunta custa menos de 1 s em vez de minutos.
3. **Não estoura o timeout da tool**: `toolTimeoutMs`/`requestTimeoutMs` de
   15 min; o abort do chamador é repassado para o `fetch` (cancelar cancela).
4. **Dá para adiantar o trabalho**: `vision_warmup` inicia o load e o agente
   segue fazendo outra coisa; depois `vision_ask` acha o modelo pronto.
5. **Modo fail-fast**: `vision_ask` com `wait: false` não espera — devolve um
   erro explicativo ("não está residente, load já iniciado") em vez de travar.
6. **Todo resultado reporta o custo**: `load_ms`, `total_ms`, `first_token_ms`,
   então o modelo (e você) sabem quando foi cold start.

## Instalação

```bash
./install.sh            # copia para ~/.dsh/profiles/web/plugins/ollama-vision e registra no cordis.patch.yml
```

Depois **reinicie o harness** (`dsh web`) para o plugin entrar na composição.
Para conferir antes de subir:

```bash
dsh --profile web --dump-config | grep -A4 ollama-vision
```

### Instalação manual

1. Copie `index.js` e `package.json` para
   `~/.dsh/profiles/web/plugins/ollama-vision/`.
   O `package.json` **precisa** existir (com `"type": "module"`): sem ele o
   Node lê o `index.js` como CommonJS e o plugin não carrega.
2. Adicione em `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: ollama-vision
      name: './plugins/ollama-vision/index.js'
      config:
        model: gemma4:e2b
        keepAlive: 30m
        warmupOnStart: true
```

O caminho do `name` é relativo ao diretório do perfil (`~/.dsh/profiles/web`).

## Configuração

Todas as chaves têm default; só declare o que quiser mudar.

| Chave | Default | Descrição |
|-------|---------|-----------|
| `baseUrl` | `http://127.0.0.1:11434` | Endereço do Ollama. |
| `model` | `gemma4:e2b` | Modelo de visão. `gemma4:e4b`/`gemma4:latest` são maiores e mais lentos no load; `qwen3.5:4b` também tem visão. |
| `keepAlive` | `30m` | Quanto tempo o modelo fica na memória depois da resposta (`-1` = para sempre, `0` = descarrega). |
| `warmupOnStart` | `true` | Pré-carrega o modelo quando o harness sobe. |
| `warmupDelayMs` | `2500` | Atraso do pré-carregamento (deixa o boot terminar primeiro). |
| `warmupWaitMs` | `600000` | Teto de espera do `vision_warmup` com `wait: true`. |
| `requestTimeoutMs` | `900000` | Teto por chamada de `vision_ask`. |
| `toolTimeoutMs` | `900000` | Orçamento da tool (usado pela política de timeout do harness). |
| `maxTokens` | `768` | Limite de tokens da resposta. |
| `temperature` | `0.2` | Temperatura. |
| `numCtx` | `0` | `num_ctx` do Ollama; `0` = default do modelo. |
| `think` | `false` | Desliga o "pensamento" (mais rápido para descrever imagem). |
| `includeThinking` | `false` | Inclui o raciocínio do modelo no resultado. |
| `maxImages` | `4` | Máximo de imagens por chamada. |
| `maxImageBytes` | `20971520` | Tamanho máximo por imagem (20 MB). |
| `maxAnswerChars` | `8000` | Trunca a resposta nesse tamanho. |
| `autoAttachments` | `true` | Sem `images`, usa o(s) anexo(s) mais recente(s) da conversa. |
| `attachmentMaxAgeMs` | `900000` | Janela de idade para considerar um anexo "recente" (15 min). |
| `dshHome` | `''` | Força o DSH_HOME (senão usa `$DSH_HOME` ou `~/.dsh`). |
| `debug` | `false` | Loga no stderr do harness (load, warmup, falhas). |

## Como usar

O agente chama sozinho, mas os argumentos aceitos são:

```jsonc
// vision_ask
{
  "prompt": "Transcreva o texto do print e diga qual botão está desabilitado.",  // obrigatório
  "images": ["/caminho/foto.png"],   // opcional: caminho, http(s), data-uri, "sha256:<id>"
  "model": "gemma4:e4b",             // opcional
  "wait": true,                      // opcional (default true)
  "timeout_ms": 900000               // opcional
}
```

**Imagem colada no chat (Ctrl+V):** não precisa passar caminho nenhum. O DSH
guarda o anexo em `~/.dsh/attachments/v1/objects/<prefixo>/<sha256>`; com
`images` omitido o plugin pega automaticamente a(s) imagem(ns) mais recente(s)
da janela (`attachmentMaxAgeMs`) e marca `auto_images: true` no resultado.

O resultado canônico traz `answer`, `model`, `images` (origem, mime, bytes),
`cold_start`, `load_ms`, `total_ms`, `first_token_ms`, tokens e `truncated`.
O que o modelo principal lê é o texto renderizado:

```
A imagem exibe um círculo azul e um quadrado amarelo.

[vision_ask · cold start: load 38.8s · total 41.3s · gemma4:e2b]
imagens: /caminho/foto.png
```

## Verificação

```bash
# 1. Ollama no ar e com visão funcionando?
ollama list
ollama ps

# 2. Testes do plugin (24 checagens: schema, render, imagem real, data-uri,
#    anexo automático, erros claros, cold start)
cd <esta pasta> && ln -sfn ~/.dsh/profiles/node_modules node_modules && node .dev/self-test.mjs

# 3. Composição do perfil
dsh --profile web --dump-config | grep -A4 ollama-vision
```

## Problemas comuns

- **`vision_ask` responde "Ollama inacessível"** — o servidor não está no ar:
  `ollama serve` (ou `systemctl status ollama`). Confira `baseUrl`.
- **Demora minutos na primeira pergunta** — é o cold start. Deixe
  `warmupOnStart: true` ou chame `vision_warmup` no começo do turno.
- **"não parece ser uma imagem suportada"** — o arquivo não tem assinatura de
  PNG/JPEG/GIF/WEBP/BMP/TIFF/AVIF (ex.: HEIC). Converta antes.
- **O modelo responde errado sobre detalhes finos** — modelo pequeno. Tente
  `model: gemma4:e4b` ou peça algo mais específico no `prompt`.
- **VRAM/memória apertada** — chame `vision_warmup` com `unload: true`, ou
  baixe `keepAlive` para `5m`.

## Notas de implementação

- Sem dependências além de `node:*` — o único import de harness é
  `defineTool` (`@deepseek-ai/dsh-tools`) e a config usa `schemastery`,
  resolvidos pelo `node_modules` do perfil.
- `/api/chat` é consumido em streaming (NDJSON) para o abort do chamador
  interromper de verdade e para medir o primeiro token.
- O load reportado vem do `load_duration` do próprio Ollama, não de estimativa.
- Nada do fluxo existente do harness é alterado: o plugin só registra tools,
  uma seção de prompt e um timer de warmup.

## Repositório

Este plugin faz parte da coleção de plugins do DSH em [../README.md](../README.md):
dependências detalhadas em [../DEPENDENCIAS.md](../DEPENDENCIAS.md), portabilidade
e backup em [../docs/portabilidade.md](../docs/portabilidade.md) e o contrato técnico
dos plugins em [../docs/contrato-plugins-dsh.md](../docs/contrato-plugins-dsh.md).
