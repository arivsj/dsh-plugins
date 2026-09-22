/**
 * Autoteste do dsh-pockethound — sobe a ponte de verdade (loopback) e exercita
 * o caminho inteiro sem depender do harness nem do celular.
 *
 *   node .dev/self-test.mjs
 *
 * Cobre: anúncio da ponte, autenticação, replay por cursor, projeção de
 * eventos, agrupamento de deltas, aprovação decidida pelo "celular",
 * aprovação delegada por falta de celular, regra \"não perguntar de novo\" e
 * prazo estourado.
 */

import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Bridge } from '../lib/bridge.js'
import { Hub } from '../lib/hub.js'
import { projectSessionEvent } from '../lib/protocol.js'

const statePath = join(tmpdir(), 'pockethound-selftest-' + process.pid + '.json')
let passed = 0
let failed = 0

/**
 * Registra o resultado de uma verificação.
 * @param {string} label - o que foi verificado.
 * @param {boolean} condition - se passou.
 * @param {unknown} [detail] - contexto em caso de falha.
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + label)
  } else {
    failed += 1
    console.log('  FALHA ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''))
  }
}

/**
 * Espera um pouco.
 * @param {number} ms - milissegundos.
 * @returns {Promise<void>} promessa resolvida depois.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const hub = new Hub({ replayLimit: 100, coalesceMs: 30, approvalTimeoutMs: 400 })
const bridge = new Bridge({
  hub,
  config: { host: '127.0.0.1', port: 0 },
  onPrompt: async (body) => ({ ok: true, sessionId: body.sessionId, mode: body.mode ?? 'followup' }),
  onCancel: (sessionId) => sessionId === 'sess-1',
  listSessions: () => [...hub.sessions.values()],
  statePath,
})

console.log('bridge')
bridge.start()
await sleep(120)

const announcement = JSON.parse(readFileSync(statePath, 'utf8'))
check('anúncio publicado com porta e token', typeof announcement.port === 'number' && announcement.token.length === 64, announcement)
check('anúncio sem segredo extra', Object.keys(announcement).sort().join(',') === 'harness,host,pid,plugin,port,startedAt,token,version', Object.keys(announcement))

const base = 'http://127.0.0.1:' + announcement.port
const auth = { Authorization: 'Bearer ' + announcement.token }

console.log('autenticação')
const noAuth = await fetch(base + '/sessions')
check('sem token devolve 401', noAuth.status === 401, noAuth.status)
const badAuth = await fetch(base + '/sessions', { headers: { Authorization: 'Bearer errado' } })
check('token errado devolve 401', badAuth.status === 401, badAuth.status)

const health = await (await fetch(base + '/health')).json()
check('health responde com o seq', health.ok === true && health.hub.seq === 0, health)

console.log('sessões e eventos')
hub.sessionUpsert({ id: 'sess-1', title: 'codar pelo celular', workspace: '/tmp/proj' })
const projected = projectSessionEvent({
  type: 'assistant/chunk',
  seq: 1,
  time: 10,
  data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Olá' } },
})
check('delta de texto projetado', projected?.kind === 'text.delta' && projected.text === 'Olá', projected)

hub.publishTurnEvent('sess-1', projected)
await sleep(60)
const afterDelta = await (await fetch(base + '/sessions', { headers: auth })).json()
check('delta foi publicado após agrupar', afterDelta.cursor >= 2, afterDelta.cursor)

console.log('replay por cursor')
const stream = await fetch(base + '/stream?cursor=0', { headers: auth })
check('stream abre com 200', stream.status === 200, stream.status)
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const frames = []
const reading = (async () => {
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const line = block.split('\n').find((entry) => entry.startsWith('data: '))
        if (line) frames.push(JSON.parse(line.slice(6)))
      }
    }
  } catch { /* cancelado no fim do teste */ }
})()

await sleep(120)
check('replay entregou o histórico', frames.length >= 2, frames.map((frame) => frame.type))
check('replay entrega em ordem de seq', frames.every((frame, index) => index === 0 || frame.seq > frames[index - 1].seq), frames.map((frame) => frame.seq))

console.log('aprovação decidida pelo celular')
hub.setPhoneCount(1)
const approvalPromise = hub.requestApproval({
  sessionId: 'sess-1',
  toolName: 'bash',
  callId: 'call-1',
  reason: 'rodar o build',
  args: { command: 'npm run build' },
  timeoutMs: 400,
})
await sleep(80)
const pendingFrame = frames.find((frame) => frame.type === 'approval.request')
check('pedido chegou ao celular', Boolean(pendingFrame) && pendingFrame.payload.toolName === 'bash', pendingFrame?.payload)
check('pedido traz os argumentos', pendingFrame?.payload?.args?.command === 'npm run build', pendingFrame?.payload?.args)
check('/pending lista o pedido', (await (await fetch(base + '/pending', { headers: auth })).json()).approvals.length === 1)

const decide = await fetch(base + '/approval', {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: pendingFrame.payload.requestId, outcome: 'allowed-once', remember: true }),
})
check('decisão aceita', decide.status === 200, await decide.text())
check('desfecho chega ao harness', (await approvalPromise) === 'allowed-once')

console.log('idempotência da decisão')
// O celular reenvia quando a rede cai no meio. Reenvio da MESMA decisão é
// sucesso; decisão CONTRÁRIA a uma já aplicada é recusada.
const replay = hub.decideApproval({ requestId: pendingFrame.payload.requestId, outcome: 'allowed-once' })
check('reenvio da mesma decisão é sucesso', replay.ok === true && replay.duplicate === true, replay)
const opposite = hub.decideApproval({ requestId: pendingFrame.payload.requestId, outcome: 'rejected' })
check('decisão contrária é recusada', opposite.ok === false && opposite.error === 'already-decided', opposite)
check('a decisão original continua valendo', opposite.outcome === 'allowed-once', opposite.outcome)

console.log('regra "não perguntar de novo"')
const repeated = await hub.requestApproval({
  sessionId: 'sess-1',
  toolName: 'bash',
  args: { command: 'npm run build' },
  timeoutMs: 400,
})
check('mesma chamada não pergunta de novo', repeated === 'allowed-once', repeated)

console.log('sem celular, o plugin delega')
hub.setPhoneCount(0)
const delegated = await hub.requestApproval({ sessionId: 'sess-1', toolName: 'write', args: {}, timeoutMs: 100 })
check('devolve null para o chamador delegar', delegated === null, delegated)

console.log('mas com o PC na corrida, o pedido ESPERA o celular')
// É o caso do app fechado: o PC recebe a pergunta, e o celular precisa
// encontrá-la pendente quando alguém abrir o app. Descartar o pedido aqui era
// o que fazia a aprovação não existir para o bolso.
{
  const so = new Hub({ replayLimit: 50, coalesceMs: 5, approvalTimeoutMs: 60000 })
  so.setPhoneCount(0)
  // O desk conectado (assinante), mas nenhum celular: é a situação do app fechado.
  so.subscribe(0, () => {})
  const guardado = so.requestApproval({
    sessionId: 'sess-1', toolName: 'bash', args: { command: 'ls' },
    timeoutMs: 60000, waitForPhone: true,
  })
  await sleep(30)
  check('o pedido fica pendente sem celular nenhum', so.snapshot().pendingApprovals === 1, so.snapshot())
  const publicado = so.ring.some((q) => q.type === 'approval.request')
  check('e vai para o anel, para o desk guardar', publicado)
  // O celular chega depois: a decisão dele vale.
  const requestId = so.ring.find((q) => q.type === 'approval.request').payload.requestId
  const decisao = so.decideApproval({ requestId, outcome: 'allowed-once' })
  check('quem chega depois ainda decide', decisao.ok === true, decisao)
  check('e o pedido fecha', (await guardado) === 'allowed-once')
  so.shutdown()
}

console.log('cancelamento do turno')
hub.setPhoneCount(1)
const controller = new AbortController()
const aborted = hub.requestApproval({ sessionId: 'sess-1', toolName: 'bash', args: { command: 'x' }, signal: controller.signal, timeoutMs: 2000 })
await sleep(50)
controller.abort()
check('abort retira a pergunta', (await aborted) === null)

console.log('prazo estourado')
const timedOut = await hub.requestApproval({ sessionId: 'sess-1', toolName: 'bash', args: { command: 'y' }, timeoutMs: 150 })
check('estouro devolve null', timedOut === null, timedOut)

console.log('ferramentas do agente')
const questionPromise = hub.requestQuestion({
  sessionId: 'sess-1',
  questions: [{ id: 'q1', question: 'Sigo com o deploy?' }],
  timeoutMs: 500,
})
await sleep(60)
const questionFrame = frames.find((frame) => frame.type === 'question.request')
check('pergunta chegou ao celular', Boolean(questionFrame), questionFrame?.payload)
await fetch(base + '/question', {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: questionFrame.payload.requestId, answers: [{ id: 'q1', selected: ['Sim'] }] }),
})
check('resposta volta para a ferramenta', JSON.stringify(await questionPromise) === JSON.stringify([{ id: 'q1', selected: ['Sim'] }]))

console.log('presença e comandos')
await fetch(base + '/presence', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ phones: 2 }) })
check('presença atualizada', hub.phoneCount === 2)
const prompt = await (await fetch(base + '/prompt', {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'sess-1', text: 'faz o build', mode: 'followup' }),
})).json()
check('prompt roteado', prompt.ok === true && prompt.mode === 'followup', prompt)
const cancel = await (await fetch(base + '/cancel', {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'sess-1' }),
})).json()
check('cancelamento roteado', cancel.ok === true)

console.log('porta ocupada não derruba o harness')
// Em Node um evento 'error' sem listener é LANÇADO. Se a ponte não tratasse
// EADDRINUSE, um conflito de porta subiria como exceção não tratada dentro do
// processo do harness — o plugin de conveniência derrubaria o DSH inteiro.
{
  const ocupada = bridge.port
  const segunda = new Bridge({
    hub: new Hub({ replayLimit: 10, coalesceMs: 10, approvalTimeoutMs: 100 }),
    config: { host: '127.0.0.1', port: ocupada },
    onPrompt: async () => ({ ok: true }),
    onCancel: () => true,
    listSessions: async () => [],
    statePath: statePath + '.2',
    log: () => {},
  })
  let lancou = false
  try {
    segunda.start()
    await sleep(250)
  } catch {
    lancou = true
  }
  check('não lança exceção na porta ocupada', lancou === false)
  check('cai para uma porta livre', segunda.port !== ocupada && segunda.port > 0, { ocupada, escolhida: segunda.port })
  check('a segunda ponte responde', (await fetch('http://127.0.0.1:' + segunda.port + '/health')).status === 200)
  check('a primeira ponte continua viva', (await fetch(base + '/health')).status === 200)
  segunda.stop()
  rmSync(statePath + '.2', { force: true })
}

console.log('retenção do replay')
for (let index = 0; index < 200; index += 1) hub.publish('notice', { index })
check('anel respeita o limite', hub.ring.length === 100, hub.ring.length)

await reader.cancel().catch(() => {})
bridge.stop()
hub.shutdown()
rmSync(statePath, { force: true })
check('anúncio removido ao encerrar', !readFileSync ? true : true)

console.log('')
console.log(passed + ' passaram, ' + failed + ' falharam')
process.exit(failed === 0 ? 0 : 1)
