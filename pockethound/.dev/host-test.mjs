/**
 * Teste da metade HOST do plugin com um `ctx` falso.
 *
 *   node .dev/host-test.mjs
 *
 * O autoteste principal exercita o hub isolado. Este aqui monta o plugin de
 * verdade — `apply(ctx, config)` — contra um contexto de mentira, e verifica o
 * que só aparece na fiação: quais eventos ele escuta, como resolve o agente de
 * uma sessão fria, como o corpus do disco entra na lista, e — o mais importante
 * — que ele DELEGA quando não há celular.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * De onde carregar o plugin.
 *
 * `lib/index.js` importa `@deepseek-ai/schemastery`, que só resolve a partir do
 * perfil do harness. Por isso o padrão é a CÓPIA INSTALADA — que, de quebra, é
 * exatamente o artefato que o harness executa. Se ela não existir, cai no
 * código do repositório (útil só para checar sintaxe).
 *
 * @returns {Promise<object>} os exports do plugin.
 */
async function carregarPlugin() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const instalado = join(dshHome, 'profiles', 'node_modules', 'dsh-pockethound', 'lib', 'index.js')
  const alvo = existsSync(instalado)
    ? instalado
    : join(import.meta.dirname, '..', 'lib', 'index.js')
  if (!existsSync(instalado)) {
    console.log('(aviso: usando o código do repositório; rode ./install.sh para testar a cópia instalada)')
  } else {
    console.log('plugin sob teste: ' + instalado)
  }
  return import(pathToFileURL(alvo).href)
}

const { apply } = await carregarPlugin()

let passed = 0
let failed = 0

/**
 * Registra o resultado de uma verificação.
 * @param {string} label - o que foi verificado.
 * @param {boolean} condition - se passou.
 * @param {unknown} [detail] - contexto em caso de falha.
 */
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + label) }
  else { failed += 1; console.log('  FALHA ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')) }
}

/**
 * Espera um pouco.
 * @param {number} ms - milissegundos.
 * @returns {Promise<void>} promessa resolvida depois.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Config completa, como o Loader entregaria. */
const config = {
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  statePath: join(mkdtempSync(join(tmpdir(), 'pockethound-host-')), 'bridge.json'),
  claimApprovals: true,
  claimQuestions: true,
  // A config do teste e escrita a mao: o padrao do schemastery NAO passa por
  // aqui, entao todo campo que muda comportamento precisa estar explicito.
  shareWithDesktop: true,
  approvalTimeoutMs: 400,
  questionTimeoutMs: 400,
  coalesceMs: 20,
  replayLimit: 50,
  registerTools: true,
  allowResume: true,
  includeSubagents: true,
  debug: false,
}

/** Sessão viva de mentira. */
const sessaoViva = {
  id: 'sess-viva',
  header: { id: 'sess-viva', cwd: '/dev/proj', createdAt: 1000 },
  events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'faz o build' }] } }],
}

/** Agente de mentira que registra o que recebeu. */
const agente = {
  id: 'sess-viva',
  recebido: [],
  followup(mensagem) { this.recebido.push({ canal: 'followup', mensagem }) },
  steer(mensagem) { this.recebido.push({ canal: 'steer', mensagem }) },
  cancel(causa) { this.recebido.push({ canal: 'cancel', causa }) },
}

const resumidos = []
const eventos = {}
const efeitos = []

// Os servicos NAO ficam como propriedade do ctx de proposito: e assim que o
// plugin os encontra em campo (camada do usuario). O acesso por propriedade vem
// undefined, e sem o fallback para ctx.get() o /prompt respondia "sessao nao
// encontrada" para uma sessao viva. Este teste existe para nao voltar.
const criadas = []
const registradas = []
const servicos = {
  agents: {
    get: (id) => (id === 'sess-viva' ? agente : undefined),
    // Criar sessao e o que o celular faz ao escolher um workspace: o harness
    // recebe o cwd por meta e nasce uma sessao NOVA naquela pasta.
    create: async ({ sessionId, meta }) => {
      criadas.push({ sessionId, cwd: meta?.cwd })
      return { agent: { id: sessionId, session: { header: { cwd: meta?.cwd } } } }
    },
    resume: async ({ resumeSessionId }) => {
      resumidos.push(resumeSessionId)
      if (resumeSessionId !== 'sess-fria') throw new Error('sessão desconhecida')
      return { agent: { ...agente, id: 'sess-fria', recebido: [] } }
    },
  },
  sessions: { list: () => [sessaoViva] },
  // As projecoes do harness — custo em dolar (plugin session-cost) e ocupacao de
  // contexto (dsh-token-meter). O plugin do celular LE daqui em vez de recalcular
  // preco; e por isso que o celular e o navegador mostram o mesmo numero.
  sessionProjections: {
    snapshot: () => ({
      asOfSeq: 7,
      values: {
        sessionCost: { modelo: 'deepseek-flash', usd: 1.506, usdPico: 1.506, amostras: 3 },
        tokenUsage: { uncachedInputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 0 },
        contextPressure: { pressureTokens: 900, projectedTokens: 1200, contextWindow: 100000 },
      },
    }),
  },
  workspaceRegistry: {
    list: () => [
      { id: 'ws-proj', title: 'PocketHound', path: '/home/u/PocketHound', sessionIds: ['sess-viva'], createdAt: 1 },
      { id: 'ws-desk', title: 'PocketHound desk', path: '/home/u/PocketHound desk', sessionIds: [], createdAt: 2 },
    ],
    get: (id) => (id === 'ws-desk' ? { id: 'ws-desk', title: 'PocketHound desk', path: '/home/u/PocketHound desk', sessionIds: [] } : undefined),
    resolveByPath: async (caminho) => (caminho === '/home/u/novo' ? undefined : { id: 'ws-x', path: caminho, sessionIds: [] }),
    create: async (caminho, title) => ({ id: 'ws-novo', path: caminho, title: title ?? caminho, sessionIds: [] }),
  },
  sessionQuery: {
    listSessions: async () => [
      { header: { id: 'sess-viva', cwd: '/dev/proj', createdAt: 1000 }, live: true, persisted: true },
      { header: { id: 'sess-fria', cwd: '/dev/antigo', createdAt: 500 }, live: false, persisted: true },
      { header: { id: 'sess-sub', cwd: '/dev/proj', createdAt: 900, origin: 'subagent', delegationDepth: 1 }, live: false, persisted: true },
    ],
  },
  // locate() é a API canônica para descobrir o arquivo da sessão sem montar o
  // caminho na mão (projectKey + encodeSegment escapam espaço como ~0020).
  sessionPersistence: {
    locate: (header) => (header ? { kind: 'jsonl', path: '/home/u/.dsh/sessions/--proj--/' + header.id + '/session.jsonl.zstd' } : undefined),
  },
  tools: {
    register: (ferramenta) => {
      registradas.push(ferramenta)
      return () => {}
    },
  },
  // A UI web registra UM provedor neste servico. O plugin envolve o que for
  // registrado para a pergunta chegar tambem ao celular — sem ocupar o assento,
  // que e exclusivo e derruba o boot se estiver ocupado.
  userQuestions: {
    registerProvider: (provedor) => {
      servicos.userQuestions.provider = provedor
      return () => { delete servicos.userQuestions.provider }
    },
    // O servico de verdade repassa a pergunta ao provedor registrado.
    ask: (request) => {
      const provedor = servicos.userQuestions.provider
      if (!provedor) return Promise.reject(new Error('no user-questions provider is registered'))
      return provedor.ask(request)
    },
  },
}

const ctx = {
  get: (nome) => servicos[nome],
  on: (nome, handler) => { eventos[nome] = handler; return () => { delete eventos[nome] } },
  effect: (corpo) => { const d = corpo(); if (typeof d === 'function') efeitos.push(d) },
  // O escopo do `inject` entrega os servicos COMO PROPRIEDADE (e assim que o
  // cordis faz); o contexto raiz da camada do usuario nao. Modelar os dois evita
  // testar uma coisa e valer outra.
  inject: (_deps, cb) => { cb({ ...servicos, get: (nome) => servicos[nome] }) },
}

apply(ctx, config)
await sleep(150)

console.log('fiação do plugin')
check('escuta session/event', typeof eventos['session/event'] === 'function', Object.keys(eventos))
check('escuta session/created', typeof eventos['session/created'] === 'function')
check('escuta approval/request', typeof eventos['approval/request'] === 'function')

console.log('lista de sessões: vivas + corpus do disco')
const anuncio = JSON.parse(readFileSync(config.statePath, 'utf8'))
const auth = { Authorization: 'Bearer ' + anuncio.token }
const base = 'http://127.0.0.1:' + anuncio.port

const lista = await (await fetch(base + '/sessions', { headers: auth })).json()
const ids = lista.sessions.map((s) => s.id)
check('a sessão viva aparece', ids.includes('sess-viva'), ids)
check('a sessão fria do disco aparece', ids.includes('sess-fria'), ids)
check('a de subagente aparece marcada', lista.sessions.find((s) => s.id === 'sess-sub')?.origin === 'subagent', lista.sessions)

console.log('workspaces: escolher ONDE trabalhar')
const workspaces = await (await fetch(base + '/workspaces', { headers: auth })).json()
check('lista os workspaces do harness', workspaces.workspaces.length === 2, workspaces.workspaces)
check('traz nome e caminho', workspaces.workspaces[0].title === 'PocketHound' && workspaces.workspaces[0].path === '/home/u/PocketHound')
check('traz os ids das sessoes de cada um', workspaces.workspaces[0].sessions.includes('sess-viva'))

const criada = await (await fetch(base + '/session', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'ws-desk' }),
})).json()
check('cria sessao no workspace pedido', criada.ok === true && criada.workspaceId === 'ws-desk', criada)
check('a sessao nasce no cwd do workspace', criadas.at(-1)?.cwd === '/home/u/PocketHound desk', criadas)

const avulso = await (await fetch(base + '/session', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: '/home/u/novo' }),
})).json()
check('caminho novo vira workspace e sessao', avulso.ok === true && avulso.workspaceId === 'ws-novo', avulso)

const semWorkspace = await (await fetch(base + '/session', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'ws-que-nao-existe' }),
})).json()
check('workspace desconhecido devolve erro claro', semWorkspace.ok === false && /nao encontrado/.test(semWorkspace.error), semWorkspace)
check('a viva vem primeiro', lista.sessions[0].status === 'live', lista.sessions[0])
check('a fria traz status cold', lista.sessions.find((s) => s.id === 'sess-fria')?.status === 'cold')
check('o workspace vem do header', lista.sessions.find((s) => s.id === 'sess-fria')?.workspace === '/dev/antigo')
check('o caminho do log vem de locate()',
  /sess-fria\/session\.jsonl\.zstd$/.test(lista.sessions.find((s) => s.id === 'sess-fria')?.logPath ?? ''),
  lista.sessions.find((s) => s.id === 'sess-fria')?.logPath)
check('o header NÃO vaza para o celular',
  lista.sessions.every((s) => !('header' in s)),
  Object.keys(lista.sessions[0]))

console.log('prompt: sessão viva, sessão fria e sessão inexistente')
const r1 = await (await fetch(base + '/prompt', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'sess-viva', text: 'roda os testes', mode: 'followup' }),
})).json()
check('prompt na sessão viva usa followup', r1.ok === true && agente.recebido.at(-1)?.canal === 'followup', r1)
check('a mensagem é do tipo usuário', agente.recebido.at(-1)?.mensagem?.role === 'user', agente.recebido.at(-1))

const r2 = await (await fetch(base + '/prompt', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'sess-fria', text: 'continua de onde paramos' }),
})).json()
check('a sessão fria foi resumida', resumidos.includes('sess-fria'), resumidos)
check('o prompt chegou no agente resumido', r2.ok === true, r2)

const r3 = await (await fetch(base + '/prompt', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'nao-existe', text: 'oi' }),
})).json()
check('sessão inexistente devolve erro claro', r3.ok === false && /não encontrada/.test(r3.error), r3)

console.log('steer, cancelamento e vazio')
await fetch(base + '/prompt', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'sess-viva', text: 'para', mode: 'steer' }),
})
check('mode steer usa steer', agente.recebido.at(-1)?.canal === 'steer')
const vazio = await (await fetch(base + '/prompt', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'sess-viva', text: '   ' }),
})).json()
check('texto vazio é recusado', vazio.ok === false && vazio.error === 'texto vazio', vazio)
const cancel = await (await fetch(base + '/cancel', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'sess-viva', cause: 'teste' }),
})).json()
check('cancelamento chega no agente', cancel.ok === true && agente.recebido.at(-1)?.canal === 'cancel')

console.log('a aprovação DELEGA quando não há celular')
// Sem presença (phoneCount = 0), o plugin precisa devolver next() — é o que
// mantém o fluxo do terminal/GUI intacto com o app fechado.
let chamouNext = false
const resultado = await eventos['approval/request'](
  { agent: { id: 'sess-viva', session: sessaoViva }, toolName: 'bash', reason: 'teste' },
  async () => { chamouNext = true; return 'allowed-once' },
)
check('sem celular, chama next()', chamouNext === true, { chamouNext, resultado })
check('o desfecho vem do respondente normal', resultado === 'allowed-once', resultado)

console.log('com celular, o plugin CLAIMA')
await fetch(base + '/presence', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ phones: 1 }),
})
// Uma conexão SSE faz o plugin considerar que há com quem falar.
const stream = await fetch(base + '/stream?cursor=0', { headers: auth })
const reader = stream.body.getReader()
const decodificador = new TextDecoder()
const quadros = []
let buffer = ''
const bomba = (async () => {
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decodificador.decode(value, { stream: true })
      let corte
      while ((corte = buffer.indexOf('\n\n')) !== -1) {
        const bloco = buffer.slice(0, corte)
        buffer = buffer.slice(corte + 2)
        const linha = bloco.split('\n').find((l) => l.startsWith('data: '))
        if (linha) quadros.push(JSON.parse(linha.slice(6)))
      }
    }
  } catch { /* encerrado no fim */ }
})()
await sleep(120)

console.log('custo e contexto vao para o celular, lidos das projecoes')
{
  const antes = quadros.length
  eventos['session/event'](
    { id: 'sess-viva', events: [], header: {} },
    {
      type: 'assistant/message',
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 10, outputTokens: 20 },
        // Um `assistant/message` de verdade traz conteudo; sem ele o evento nem
        // vira quadro, e o retrato (que pega carona no fechamento do passo)
        // nunca sairia. O teste tem de parecer com o campo.
        message: { content: [{ type: 'text', text: 'oi' }] },
      },
    },
  )
  await sleep(150)
  const novos = quadros.slice(antes)
  const retrato = novos.find((q) => q.type === 'turn.event' && q.payload?.kind === 'stats')
  check('o retrato chega ao celular', Boolean(retrato), novos.map((q) => q.type + ':' + (q.payload?.kind ?? '')))
  check('traz o gasto em dolar', retrato?.payload?.usd === 1.506, retrato?.payload)
  check('traz quanto saiu no pico', retrato?.payload?.usdPico === 1.506, retrato?.payload)
  check('traz a entrada e a saida', retrato?.payload?.entrada === 4000 && retrato?.payload?.saida === 2000, retrato?.payload)
  check(
    'traz a ocupacao do contexto (o que a proxima requisicao leva)',
    retrato?.payload?.contextoUsado === 1200 && retrato?.payload?.contextoJanela === 100000,
    retrato?.payload,
  )
  check('o retrato vai marcado com a sessao', retrato?.session === 'sess-viva', retrato?.session)
}

// A tela do PC (next) recebe a MESMA pergunta e fica esperando o humano — que e
// o que o respondente normal do harness faz. Modelar isso importa: com um next()
// que responde na hora, o teste estaria medindo uma corrida que na vida real nao
// acontece.
let nextComCelular = false
let responderNoPc = null
const esperaDoHumano = new Promise((resolve) => { responderNoPc = resolve })
const pendente = eventos['approval/request'](
  { agent: { id: 'sess-viva', session: sessaoViva }, toolName: 'write', callId: 'c1', reason: 'escrever arquivo' },
  async () => { nextComCelular = true; return esperaDoHumano },
)
await sleep(120)
const pedido = quadros.find((q) => q.type === 'approval.request')
check('o pedido foi publicado para o celular', Boolean(pedido), quadros.map((q) => q.type))
check('a tela do PC recebe a pergunta na MESMA hora', nextComCelular === true)
check('o pedido traz a ferramenta e o motivo', pedido?.payload?.toolName === 'write' && pedido?.payload?.reason === 'escrever arquivo')

await fetch(base + '/approval', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: pedido.payload.requestId, outcome: 'allowed-once' }),
})
check('a decisão do celular vence', (await pendente) === 'allowed-once')

console.log('com o PC respondendo primeiro, o cartão do celular sai da tela')
const pendenteNoPc = eventos['approval/request'](
  { agent: { id: 'sess-viva', session: sessaoViva }, toolName: 'bash', callId: 'c2', reason: 'rodar comando' },
  async () => 'rejected',
)
await sleep(80)
// Casado pelo requestId: a resolução do caso anterior ainda pode estar em voo, e
// procurar "a última resolução" mediria o caso errado.
const pedidoNoPc = quadros.filter((q) => q.type === 'approval.request').at(-1)
check('o desfecho do PC vence', (await pendenteNoPc) === 'rejected')
await sleep(120)
const retirada = quadros.find(
  (q) => q.type === 'approval.resolved' && q.payload?.requestId === pedidoNoPc?.payload?.requestId,
)
check(
  'o cartão do celular é retirado na hora',
  retirada?.payload?.by === 'desktop' && retirada?.payload?.outcome === 'rejected',
  retirada?.payload,
)


console.log('perguntas: celular e tela do PC ao mesmo tempo')
// O contrato do provedor devolve { answers } — e o que a ferramenta nativa do
// harness espera.
const daTela = { ask: async () => { await sleep(120); return { answers: [{ id: 'q1', selected: ['da tela'] }] } } }
servicos.userQuestions.registerProvider(daTela)
check('o provedor da UI fica envolvido', servicos.userQuestions.provider !== daTela)

const antesPerguntas = quadros.length
const respostaPromessa = servicos.userQuestions.provider.ask({
  agent: { id: 'sess-viva' },
  questions: [{ id: 'q1', question: 'Qual caminho?', options: [{ label: 'a' }, { label: 'b' }] }],
})
// 40 ms: menos que os 120 ms da tela, para a corrida medir o celular vencendo.
await sleep(40)
const pedidoDePergunta = quadros.slice(antesPerguntas).find((q) => q.type === 'question.request')
check('a pergunta chega ao celular', Boolean(pedidoDePergunta), quadros.slice(antesPerguntas).map((q) => q.type))
check('traz as opcoes', pedidoDePergunta?.payload?.questions?.[0]?.options?.length === 2)

await fetch(base + '/question', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: pedidoDePergunta.payload.requestId, answers: [{ id: 'q1', selected: ['do celular'] }] }),
})
check('a resposta do celular vence', (await respostaPromessa)?.answers?.[0]?.selected?.[0] === 'do celular')

const antesTela = quadros.length
const respostaDaTela = servicos.userQuestions.provider.ask({ agent: { id: 'sess-viva' }, questions: [{ id: 'q1', question: 'Outra?' }] })
await sleep(40)
const pedidoDaTela = quadros.slice(antesTela).find((q) => q.type === 'question.request')
check('a tela do PC responde normalmente', (await respostaDaTela)?.answers?.[0]?.selected?.[0] === 'da tela')
await sleep(80)
// Casado pelo requestId: o celular tambem publica resolucao agora, e procurar
// "a ultima resolucao" mediria o caso anterior.
const retiradaDaPergunta = quadros.find(
  (q) => q.type === 'question.resolved' && q.payload?.requestId === pedidoDaTela?.payload?.requestId,
)
check('o cartao do celular e retirado quando a tela responde', retiradaDaPergunta?.payload?.by === 'desktop', retiradaDaPergunta?.payload)


console.log('pockethound_ask: pergunta nos dois lugares')
const ferramentaAsk = registradas.find((f) => f.name === 'pockethound_ask')
check('a ferramenta do agente esta registrada', Boolean(ferramentaAsk), registradas.map((f) => f.name))
const antesDaFerramenta = quadros.length
const resultadoDaFerramenta = await ferramentaAsk.execute(
  { question: 'Sigo?', header: 'Teste', options: [{ label: 'sim' }, { label: 'nao' }] },
  { agent: { id: 'sess-viva' } },
)
check('a resposta chega pela tela do PC', resultadoDaFerramenta?.selected?.[0] === 'da tela', resultadoDaFerramenta)
await sleep(80)
const pedidoDaFerramenta = quadros.slice(antesDaFerramenta).find((q) => q.type === 'question.request')
check('e a mesma pergunta chega ao celular', Boolean(pedidoDaFerramenta))

console.log('desligamento limpa o pendente')
for (const efeito of efeitos.reverse()) { try { efeito() } catch { /* ignora */ } }
await reader.cancel().catch(() => {})
rmSync(config.statePath, { force: true })
check('não sobra aprovação pendente', true)

console.log('')
console.log(passed + ' passaram, ' + failed + ' falharam')
process.exit(failed === 0 ? 0 : 1)
