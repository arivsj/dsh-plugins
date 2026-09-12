# dsh-pockethound

Plugin do **DeepSeek Harness** que transforma o harness em algo operável do bolso.

Ele faz quatro coisas, e só isso:

1. **Transmite o que o agente produz** — texto digitando ao vivo, raciocínio,
   chamadas de ferramenta, resultados, listas de tarefas. Tudo sai daqui já
   projetado num protocolo enxuto, com `seq` monotônico para replay.
2. **Deixa o celular decidir as aprovações.** Entra no waterfall
   `approval/request` e manda a pergunta para o telefone. **Sem celular
   conectado, chama `next()`** e a decisão volta ao respondente normal — nada
   do fluxo atual muda quando o app está fechado.
3. **Sobe uma ponte de loopback** que o app `PocketHound desk` consome.
4. **Dá duas ferramentas ao agente**: `pockethound_notify` (avisar) e
   `pockethound_ask` (perguntar e esperar a resposta).

O plugin **não** conhece celular, QR code, relay nem rede externa. Quem fala P2P
é o app do PC. Assim o harness nunca fica exposto, e o transporte pode mudar sem
tocar no DSH.

```
DSH  ──session/event──►  hub  ──SSE 127.0.0.1──►  PocketHound desk  ──P2P──►  celular
     ──approval/request─►
```

## Instalação

```bash
./install.sh              # instala em todos os perfis
./install.sh --uninstall  # remove
```

O pacote vai para `$DSH_HOME/profiles/node_modules/dsh-pockethound` (o farm
compartilhado, então todo perfil resolve o nome) e a entry é escrita na
**camada do usuário** `$DSH_HOME/cordis.patch.yml` — a que vale para todos os
perfis e todos os workspaces.

A entry é aplicada **a quente**: não precisa reiniciar o `dsh web`.

> **Cuidado com o alcance do hot-reload.** A entry nova entra sozinha, mas o
> *corpo* do plugin só é trocado quando o arquivo muda de conteúdo. Se você
> reinstalar com `lib/index.js` idêntico ao que já estava carregado (mudando só
> `lib/hub.js`, por exemplo), o processo em execução **continua no módulo
> antigo** e nada avisa. Sintoma: o comportamento não muda e a porta do anúncio
> segue a mesma. Nesse caso, reinicie o `dsh` — não há meio-termo.

## Autotestes

Dois, e eles testam coisas diferentes:

```bash
node .dev/self-test.mjs   # o hub isolado
node .dev/host-test.mjs   # o plugin montado com um ctx falso
```

**`self-test.mjs`** sobe a ponte de verdade em loopback e verifica anúncio,
autenticação, replay por cursor, projeção de eventos, agrupamento de deltas,
aprovação decidida pelo "celular", delegação por falta de celular, regra "não
perguntar de novo", cancelamento, prazo estourado, idempotência da decisão,
ferramentas e retenção do buffer.

**`host-test.mjs`** chama `apply(ctx, config)` contra um contexto de mentira e
verifica o que só aparece na fiação: quais eventos o plugin escuta, como resolve
o agente de uma sessão fria, como o corpus do disco entra na lista, e que ele
**delega quando não há celular**.

> O `host-test` importa a **cópia instalada** (`~/.dsh/profiles/node_modules/`),
> não o código do repositório — é o artefato que o harness executa de verdade, e
> `schemastery` só resolve de dentro do perfil. Consequência prática: ele falha
> se você editar o repositório e esquecer de rodar `./install.sh`. Isso é
> intencional; foi assim que ele pegou uma cópia velha durante o desenvolvimento.

## A ponte

O anúncio fica em `~/.dsh/pockethound/bridge.json` (modo `0600`), com porta e
token efêmeros:

```json
{ "version": 1, "host": "127.0.0.1", "port": 45517, "token": "…64 hex…", "pid": 41230 }
```

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/health` | versão, pid, contadores, nº de sessões — **sem token** |
| `GET` | `/sessions` | sessões vivas |
| `GET` | `/pending` | aprovações pendentes agora (reconstruir a tela) |
| `GET` | `/stream?cursor=N` | **SSE** com replay de tudo depois de `N` |
| `POST` | `/prompt` | `{ sessionId, text, mode }` — entrega um prompt no inbox |
| `POST` | `/approval` | `{ requestId, outcome, remember? }` — decide |
| `POST` | `/question` | `{ requestId, answers }` — responde uma pergunta |
| `POST` | `/presence` | `{ phones }` — o app informa quantos celulares estão ligados |
| `POST` | `/cancel` | `{ sessionId, cause }` — cancela o turno |

Menos `/health`, tudo exige `Authorization: Bearer <token>`.

## Configuração

```yaml
- insert:
    - id: pockethound
      name: 'dsh-pockethound'
      config:
        enabled: true
        claimApprovals: true      # aprovações vão para o celular
        claimQuestions: true      # perguntas também (só se o assento estiver vago)
        approvalTimeoutMs: 90000  # no estouro, delega ao respondente normal
        questionTimeoutMs: 300000
        coalesceMs: 40            # agrupa deltas de texto antes de enviar
        replayLimit: 4000         # quadros guardados para replay
        registerTools: true
        debug: false
```

| Chave | Padrão | Para quê |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `0` | escuta. `0` = porta livre escolhida pelo sistema |
| `statePath` | `$DSH_HOME/pockethound/bridge.json` | onde publicar o anúncio |
| `claimApprovals` | `true` | reivindicar `approval/request` |
| `claimQuestions` | `true` | assumir `userQuestions` **apenas se ninguém mais assumiu** |
| `approvalTimeoutMs` | `90000` | prazo do celular. Estourou → delega |
| `allowResume` | `true` | resumir do disco uma sessão fria quando chega prompt para ela |
| `includeSubagents` | `true` | incluir sessões de subagente (vêm marcadas com `origin` e `depth`) |

## Como uma aprovação viaja

```
DSH `approval/request`  →  hub.requestApproval()
                              ├─ há regra "não perguntar de novo"?  → responde já
                              ├─ sem celular / sem assinante?       → null → next()
                              └─ senão: publica approval.request e espera
                                          │
                                     celular decide
                                          │
                              `allowed-once` | `rejected`  → devolve ao waterfall
```

O desfecho é sempre um valor do vocabulário fechado do DSH
(`allowed-once`, `rejected`, `cancelled`, `unavailable`). `null` nunca chega ao
harness: vira `next()`.

**Decisão que não trava a sessão:** o prazo é sempre finito e o `abort` do turno
retira a pergunta do celular na hora.

## Sessões vivas e sessões frias

`GET /sessions` devolve **as duas coisas**: o que está rodando agora (`status:
"live"`) e o que existe só como log no disco (`status: "cold"`). Só as vivas não
bastariam — o harness reinicia e as conversas de ontem sumiriam da lista do
celular, quando na verdade elas continuam existindo e podem ser retomadas.

Com `allowResume: true`, mandar um prompt para uma sessão fria **carrega o log do
disco e sobe o loop** antes de entregar a mensagem. É o que permite abrir o app
no ônibus e continuar uma conversa que ficou pela metade no PC.

Sessões de subagente aparecem marcadas:

```json
{ "id": "…", "status": "cold", "origin": "subagent", "depth": 1 }
```

O harness delega muito e cada subagente emite bastante evento. A marcação deixa o
celular decidir o que mostrar em vez de o plugin esconder informação. Desligue
com `includeSubagents: false` se preferir só as conversas suas.

## Ferramentas que o agente ganha

| Ferramenta | Para quê |
|---|---|
| `pockethound_notify` | manda uma notificação (`info`/`success`/`warn`/`error`) sem esperar resposta |
| `pockethound_ask` | pergunta com opções e **espera a resposta do celular** |

Ambas falham rápido quando não há celular — nunca penduram o agente.

## Detalhes de implementação que não são óbvios

- **`inject = []` de propósito.** O plugin ativa em qualquer perfil. Tudo que
  precisa de um serviço específico (`tools`, `userQuestions`, `sessions`) entra
  em `ctx.inject`, que só roda onde o serviço existe. Declarar `webServer` ou
  `tools` no `inject` deixaria a entry pendente num perfil sem eles e o
  `assertEntriesActivated` derrubaria o boot.
- **O assento de `userQuestions` é único.** A UI web já registra o provedor
  dela; `registerProvider` lança se o assento estiver ocupado — e a UI web
  **derruba o boot** nesse caso, porque registra sem checar. O `try/catch` só
  protegeria o PocketHound se ele registrasse depois, mas ele monta **antes** (a
  UI depende de muito mais serviços). Por isso a decisão é tomada pelo que a
  árvore do Loader declara: se houver uma entry `@deepseek-ai/dsh-host-apiproxy`
  (ou o serviço `apiProxy` já ativo), o PocketHound não assume o assento. Em
  perfis headless, sem essa UI, ele registra e as perguntas vão para o celular.
  Nenhuma UI que já funciona é deslocada.
- **Os argumentos da aprovação são relidos do log.** O `ApprovalRequest` do DSH
  não carrega os argumentos (o `callId` aponta para a chamada já transmitida).
  Sem reler o `tool/call` correspondente, o humano decidiria às cegas.
- **`seq` é do PC, não do celular.** O app do PC repassa os quadros 1:1 e usa o
  mesmo cursor, então existe **uma** sequência no sistema inteiro. Cair de P2P
  para direto não perde nada: o celular manda `subscribe { cursor }` e o PC
  reenvia o buraco.
- **A anel de replay é limitado** (`replayLimit`). Um cursor mais antigo que o
  anel recebe só o que ainda está lá — o app detecta pelo `seq` do primeiro
  quadro e refaz o snapshot.

## Segurança

- Escuta **só em loopback**. Nunca `0.0.0.0`.
- Token de 32 bytes gerado a cada boot, comparado com `timingSafeEqual`.
- Anúncio escrito com modo `0600` e de forma atômica (`.tmp` + `rename`).
- Não existe confiança por IP: **estar em `127.0.0.1` não autoriza nada.** Essa
  foi a falha crítica do projeto anterior (um proxy local fazia toda requisição
  remota chegar como loopback e ganhar acesso administrativo) e aqui ela não
  pode se repetir.
- O plugin nunca loga token, argumentos de ferramenta ou conteúdo de conversa.

## Estrutura

```
pockethound/
├── package.json
├── install.sh
├── lib/
│   ├── index.js      # metade host: observa sessões, aprovações, ferramentas
│   ├── hub.js        # estado, anel de replay, aprovações pendentes, agrupamento
│   ├── bridge.js     # servidor HTTP/SSE de loopback + anúncio
│   └── protocol.js   # vocabulário dos quadros + projeção dos eventos do DSH
└── .dev/
    └── self-test.mjs
```
