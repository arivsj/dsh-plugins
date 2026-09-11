# Como funciona um plugin do DSH (contrato observado)

Conhecimento acumulado ao escrever os plugins deste repositório, contra o DSH
`0.1.0-rc.7`. Serve para manter os plugins atuais e para criar novos sem
redescobrir as armadilhas.

## 1. Dois sabores de plugin local

| | host-only | dual-face (host + navegador) |
|---|---|---|
| exemplo aqui | `ollama-vision` | `voice-input` |
| onde fica instalado | `~/.dsh/profiles/web/plugins/<nome>/` | `~/.dsh/profiles/web/node_modules/<nome-do-pacote>/` |
| como a entry o referencia | caminho relativo: `name: './plugins/ollama-vision/index.js'` | nome do pacote: `name: 'dsh-voice-input'` |
| por quê | o Loader resolve caminhos relativos ao perfil | o navegador resolve o bundle com `require.resolve('<pacote>/package.json')`, ancorado no diretório do perfil — só funciona para pacote real em `node_modules` |

Regra prática: **se o plugin tem UI no navegador, ele precisa ser um pacote**.

## 2. Estrutura de um pacote dual-face

```
node_modules/dsh-voice-input/
├── package.json      # name, exports ("." e "./client" e "./package.json"), dsh.client
├── lib/index.js      # metade host (ESM)
└── lib/client.js     # metade cliente (script clássico, sem import/export)
```

```json
{
  "name": "dsh-voice-input",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] } }
}
```

A entry no `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: voice-input
      name: 'dsh-voice-input'   # nome do pacote, resolvido pelos dois lados
      config:                   # só chega à metade host
        model: small
        language: pt
```

## 3. Metade host

```js
import z from '@deepseek-ai/schemastery'

const name = 'voice-input'
const inject = ['webServer']            // serviços do host que o plugin usa
const Config = z.object({ model: z.string().default('small') })

function apply(ctx, config) {           // config já validado pelo Loader
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',                     // 'exact' | 'prefix'
    path: '/voice-input/transcribe',
    handler: async (req, res) => {      // o handler é dono da resposta
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      // …
    },
  }), 'voice-input: rota de transcricao')
}

export { Config, apply, inject, name }
```

Serviços úteis no host: `webServer` (rotas HTTP), `tools` (+ `defineTool` de
`@deepseek-ai/dsh-tools`) para ferramentas do agente, `systemPrompt` para
`section({ name, order, text })`.

## 4. Metade cliente (bundle do navegador)

O arquivo é carregado como **script clássico** — nada de `import`/`export` — e
apenas registra uma factory:

```js
window.__ModuleLoader__.load({
  id: 'dsh-voice-input',               // TEM de ser igual ao nome do pacote
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');   // só a tabela fixa do shell
    function apply(ctx) { /* … */ }
    exports.apply = apply;
    exports.inject = ['slots'];       // serviços do navegador
    return module.exports;
  },
});
```

`require` aceita apenas: `react`, `react/jsx-runtime`, `react-dom`,
`react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`,
`@deepseek-ai/dsh-client-web-react`, `@deepseek-ai/dsh-client-ui-primitives`,
`@deepseek-ai/dsh-client-ui-attachment`, `@deepseek-ai/dsh-client-schema-form`.
Sem bundler e sem JSX: use `React.createElement`.

O bundle é servido em `/plugins/<id>/client.js?rev=<hash>` e entra no
`window.__DSH_BOOT__` injetado no `index.html`.

## 5. Slots de UI

```js
function apply(ctx) {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: 'voice-input', order: 60 },
    MicButton,
  ));
}
```

- Slot `list` exige `id` (id novo = célula ao lado; id existente = substitui).
- Use `ctx.slots.inject(chave, cb)` em vez de registrar direto: o slot é
  declarado por outro plugin (`ui-conversation`), que pode montar depois.
- Registrar em slot não declarado lança erro.

Slots úteis do composer e arredores:

| slot | tipo | onde é |
|---|---|---|
| `conversation.input.left` | list | extremidade esquerda da barra interna do composer |
| `conversation.input.right` | list | extremidade direita, antes do botão enviar |
| `conversation.input.dock` | list | faixa acima do card do composer |
| `conversation.composer.dock` | list | faixa abaixo do card |
| `conversation.session.header.actions` | list | ações no cabeçalho da sessão |
| `conversation.input.plan` / `.model` | single | assentos nomeados da barra do composer |

## 6. Props que os componentes recebem

Componentes de slot recebem o *owner share* do slot mais o *standard kit* da
sessão. Nos slots de entrada do composer (`InputZone`):

- `props.input` → snapshot do estado da caixa (`draft`, `imageIds`, `phase`…).
- `props.inputActions.setDraft(texto)` → caminho público de escrita do rascunho
  (**substitui** o texto: concatene com `props.input.draft` para anexar).
- `props.sessionId`, `props.useSession`, `props.useInput`, `props.useProjection`.

## 7. Ciclo de vida (o que exige F5 e o que não exige)

| mudança | efeito |
|---|---|
| acrescentar/alterar entry no `cordis.patch.yml` | aplicado **a quente** no host |
| ver o plugin novo no navegador | **F5** (o grafo de módulos só é lido no boot) |
| editar `lib/client.js` da cópia instalada | hot-swap ~500 ms, sem F5 |
| editar `lib/index.js` da cópia instalada | hot-swap do plugin host |
| mudar `package.json` (nome, exports, `dsh.client`) | exige reiniciar o `dsh web` (o metadado fica em cache no processo) |
| editar o repositório | rodar `./install-all.sh` de novo; o harness roda a cópia instalada |

## 8. Armadilhas (todas silenciosas ou fatais)

1. `name` da entry como caminho relativo + UI no navegador: o plugin é
   **ignorado** pelo scan de cliente, sem erro no log.
2. `exports` sem `"./package.json"`: a resolução do scan falha em silêncio.
3. `dsh.client.platform` diferente de `"web"`: idem.
4. `dsh.client` declarado e arquivo do bundle ausente: **o boot inteiro falha**.
5. `id` do `load({ id })` diferente do nome do pacote: a factory nunca materializa.
6. `client.js` escrito como ESM (`import`/`export`): não carrega (é script clássico).
7. `register` em slot `list` sem `id`: lança na hora.
8. `install.sh` que só grava a entry quando ela não existe: ao mover a pasta do
   repositório, os caminhos absolutos ficam velhos — por isso os instaladores
   deste repositório reescrevem o bloco inteiro.

## 9. Como testar sem depender do navegador do usuário

1. **Host**: instancie o plugin com um `ctx` falso (`effect`, `webServer.register`),
   capture as rotas e chame o handler com um `IncomingMessage` de mentira
   (`Readable.from(buffer)` + `.method` + `.headers`). É o que
   `voice-input/.dev/self-test.mjs` faz, com ffmpeg e Whisper de verdade.
2. **Cliente**: carregue `client.js` num `vm` com `window`, `document` e
   `navigator` falsos e um `require` que devolve um React mínimo com
   `createElement`/`useState`/`useRef`/`useEffect` — permite simular clique,
   gravação e resposta do backend (`voice-input/.dev/client-self-test.mjs`).
3. **Navegador real**: suba o Chrome headless com `--remote-debugging-port`, fale
   CDP (`/json/new`, `Runtime.evaluate`, `Runtime.consoleAPICalled`) e verifique o
   DOM e o console (`voice-input/.dev/browser-probe.mjs` e `browser-e2e.mjs`).

## 10. Onde tudo fica instalado

```
~/.dsh/profiles/web/
├── cordis.patch.yml                 # as entries dos plugins locais
├── package.json                     # bundles do perfil (dsh.profile.bundles)
├── plugins/ollama-vision/           # plugin host-only (cópia)
└── node_modules/dsh-voice-input/    # pacote dual-face (cópia)
```

O harness lê esse perfil no boot e observa o `cordis.patch.yml` em tempo de
execução — daí o F5 em vez de reiniciar.

## 11. Perfis, camada do usuário e dependências opcionais

O DSH compõe a árvore de plugins em camadas, nesta ordem:

```
bundles do perfil (dsh.profile.bundles)
  → ~/.dsh/profiles/<perfil>/cordis.patch.yml   (camada do perfil)
  → ~/.dsh/cordis.patch.yml                     (camada do USUÁRIO: todo perfil)
  → overlays --patch                            (por invocação)
  → patches derivados de flags (ex.: telemetria)
```

A camada do usuário é o lugar certo para um plugin que deve existir em
**todos** os perfis — é a definição dela no código do DSH: *machine-local
preferences that apply to every profile, so it outranks the per-profile layer*.

Duas consequências que não são óbvias:

1. **Id repetido entre camadas é fatal**: o Loader lança
   `duplicate loader entry id: <id>`. Ao mover um plugin da camada do perfil para
   a do usuário, remova a entrada antiga — e evite deixar as duas visíveis ao
   mesmo tempo (o watcher aplica cada estado intermediário).
2. **Serviço exclusivo de um perfil não pode ser dependência obrigatória**: no
   fim do boot o DSH audita a árvore (`assertEntriesActivated`) e **derruba o
   processo** se alguma entry ficou pendente esperando serviço. Perfis headless,
   por exemplo, têm `tools` e `systemPrompt`, mas **não** têm `webServer`.

Para depender de algo opcional, use o idioma do cordis:

```js
const inject = []                       // ativa em qualquer perfil
function apply(ctx, config) {
  ctx.inject(['webServer'], (scope) => {   // roda quando (e se) existir
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: '/x', handler }), 'rota')
  })
}
```

E deixe o trabalho pesado (workers, timers, warmup) **dentro** desse callback:
em um perfil sem o serviço o plugin não gasta recurso nenhum.

### Resolver o nome do pacote em qualquer perfil

Entry com nome *bare* (`name: 'dsh-voice-input'`) é resolvida a partir do
diretório do perfil, subindo a árvore de `node_modules`. Por isso o pacote é
instalado em `~/.dsh/profiles/node_modules/` — o farm compartilhado que o próprio
DSH mantém (`healProfilesModuleFallback`) — e não em `profiles/web/node_modules`,
que só serve ao perfil web.

### Verificar a composição sem subir o harness

```bash
dsh --profile web --dump-config       | grep -A3 'id: voice-input'
dsh --profile headless --dump-config  | grep -A3 'id: voice-input'
```

Em um `DSH_HOME` de teste (por exemplo `DSH_HOME=/tmp/fh`) dá para conferir a
composição de perfis que ainda nem existem na sua máquina.
