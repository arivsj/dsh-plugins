/**
 * Hub — o estado de tudo que o PocketHound sabe sobre o Harness vivo.
 *
 * Responsabilidades: numerar quadros, guardar os últimos N para replay,
 * distribuir para os assinantes, agrupar deltas de texto e intermediar os
 * pedidos de aprovação entre o DSH e o celular.
 *
 * @module dsh-pockethound/hub
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { OUTBOUND, PROTOCOL_VERSION } from './protocol.js'

/**
 * Agrupa deltas de texto para não inundar o rádio com um token por quadro.
 *
 * Um modelo rápido emite dezenas de deltas por segundo; o celular não precisa
 * de 40 quadros por segundo para desenhar a mesma frase. A janela troca
 * fluidez imperceptível por banda.
 */
class DeltaCoalescer {
  /**
   * @param {number} windowMs - janela de agrupamento em milissegundos.
   * @param {(key: string, payload: object) => void} flush - entrega do agregado.
   */
  constructor(windowMs, flush) {
    this.windowMs = windowMs
    this.flush = flush
    /** @type {Map<string, {payload: object, timer: NodeJS.Timeout}>} */
    this.pending = new Map()
  }

  /**
   * Enfileira um delta, agregando pelo mesmo destino.
   * @param {string} key - identidade do fluxo (sessão/turno/passo/canal).
   * @param {object} payload - payload do delta.
   */
  push(key, payload) {
    const existing = this.pending.get(key)
    if (existing) {
      existing.payload.text += payload.text
      return
    }
    const entry = { payload: { ...payload }, timer: null }
    entry.timer = setTimeout(() => {
      this.pending.delete(key)
      this.flush(key, entry.payload)
    }, this.windowMs)
    if (typeof entry.timer.unref === 'function') entry.timer.unref()
    this.pending.set(key, entry)
  }

  /** Descarrega tudo agora — usado antes de consolidar ou encerrar. */
  drain() {
    for (const [key, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(key)
      this.flush(key, entry.payload)
    }
  }
}

/** Hub central do PocketHound. */
export class Hub {
  /**
   * @param {object} options - configuração resolvida do plugin.
   * @param {number} options.replayLimit - quantos quadros guardar para replay.
   * @param {number} options.coalesceMs - janela de agrupamento dos deltas.
   * @param {number} options.approvalTimeoutMs - prazo para o celular decidir.
   * @param {number} options.maxPendingApprovals - teto de perguntas simultâneas.
   */
  constructor(options) {
    this.options = options
    this.limit = options.replayLimit
    this.startedAt = Date.now()
    this.seq = 0
    /** @type {object[]} */
    this.ring = []
    /** @type {Set<{send: Function, cursor: number}>} */
    this.subscribers = new Set()
    /** @type {Map<string, object>} */
    this.sessions = new Map()
    /** @type {Map<string, {resolve: Function, timer: NodeJS.Timeout, frame: object, toolName: string}>} */
    this.pendingApprovals = new Map()
    /** @type {Map<string, {requestId: string, resolve: Function, timer: NodeJS.Timeout}>} */
    this.pendingQuestions = new Map()
    /** Últimas decisões aplicadas, para reconhecer reenvios do celular. @type {Map<string, string>} */
    this.decided = new Map()
    /**
     * Regras "não pergunte de novo" — por sessão, por ferramenta e por digest.
     * @type {Map<string, Array<{toolName: string, digest: string, outcome: string}>}
     */
    this.rules = new Map()
    /**
     * Mensagens esperando a vez, por sessao.
     *
     * O evento do Harness so diz o DELTA (entrou X, saiu Y) e o celular nao pode
     * somar isso sozinho: um replay depois de reconexao contaria duas vezes. Aqui
     * o numero e absoluto, entao qualquer quadro perdido se corrige no proximo.
     *
     * @type {Map<string, number>}
     */
    this.queues = new Map()
    this.phoneCount = 0
    this.counters = { frames: 0, dropped: 0, approvals: 0, autoApproved: 0, timeouts: 0 }
    this.coalescer = new DeltaCoalescer(options.coalesceMs, (_key, payload) => {
      this.publish(OUTBOUND.TURN_EVENT, payload, payload.sessionId)
    })
  }

  /**
   * Numera e distribui um quadro.
   * @param {string} type - tipo do quadro (ver OUTBOUND).
   * @param {object} payload - conteúdo específico do tipo.
   * @param {string} [sessionId] - sessão à qual o quadro pertence.
   * @returns {object} o quadro publicado.
   */
  publish(type, payload, sessionId) {
    const frame = {
      v: PROTOCOL_VERSION,
      seq: ++this.seq,
      ts: Date.now(),
      type,
      session: sessionId,
      payload,
    }
    this.counters.frames += 1
    this.ring.push(frame)
    if (this.ring.length > this.limit) this.ring.splice(0, this.ring.length - this.limit)
    for (const subscriber of this.subscribers) {
      if (subscriber.cursor >= frame.seq) continue
      try {
        subscriber.send(frame)
        subscriber.cursor = frame.seq
      } catch {
        this.counters.dropped += 1
        this.subscribers.delete(subscriber)
      }
    }
    return frame
  }

  /**
   * Registra um assinante e reenvia o que ele perdeu.
   * @param {number} cursor - último seq que o cliente já processou.
   * @param {(frame: object) => void} send - entrega de um quadro.
   * @returns {{cursor: number, close: () => void}} controle da assinatura.
   */
  subscribe(cursor, send) {
    const from = Number.isFinite(cursor) ? cursor : 0
    const subscriber = { cursor: from, send }
    for (const frame of this.ring) {
      if (frame.seq > from) send(frame)
    }
    subscriber.cursor = this.seq
    this.subscribers.add(subscriber)
    this.publish(OUTBOUND.REPLAY_DONE, { from, delivered: this.seq - from })
    return {
      cursor: subscriber.cursor,
      close: () => { this.subscribers.delete(subscriber) },
    }
  }

  /** @returns {number} quantidade de assinantes conectados. */
  get subscriberCount() {
    return this.subscribers.size
  }

  /**
   * Avisa que a contagem de celulares mudou.
   * @param {number} count - celulares conectados ao desk.
   */
  setPhoneCount(count) {
    this.phoneCount = Math.max(0, Number(count) || 0)
  }

  /**
   * Registra ou atualiza uma sessão e anuncia a mudança.
   * @param {object} info - identidade e metadados da sessão.
   * @param {string} info.id - identificador da sessão.
   * @param {string} [info.title] - título legível.
   * @param {string} [info.workspace] - diretório de trabalho.
   * @param {string} [info.status] - estado do agente.
   * @returns {object} a sessão registrada.
   */
  sessionUpsert(info) {
    const previous = this.sessions.get(info.id) ?? {}
    const merged = { ...previous, ...info, lastSeen: Date.now() }
    this.sessions.set(info.id, merged)
    this.publish(OUTBOUND.SESSION_UPSERT, merged, info.id)
    return merged
  }

  /**
   * Remove uma sessão e encerra o que dependia dela.
   * @param {string} id - identificador da sessão.
   */
  sessionGone(id) {
    if (!this.sessions.delete(id)) return
    this.rules.delete(id)
    this.queues.delete(id)
    this.publish(OUTBOUND.SESSION_GONE, { id }, id)
  }

  /**
   * Publica um evento de turno, agregando os deltas de texto.
   * @param {string} sessionId - sessão de origem.
   * @param {object} payload - payload já projetado.
   */
  publishTurnEvent(sessionId, payload) {
    // A fila e estado do hub, nao do evento: ele traz so o delta.
    if (payload.kind === 'inbox') {
      const antes = this.queues.get(sessionId) ?? 0
      const fila = Math.max(0, antes + (payload.inserted ?? 0) - (payload.removed ?? 0))
      this.queues.set(sessionId, fila)
      this.publish(OUTBOUND.TURN_EVENT, { kind: 'inbox', queued: fila, sessionId }, sessionId)
      return
    }
    // Consolidar o texto fecha o fluxo de deltas pendentes daquele passo.
    if (payload.kind === 'text.done' || payload.kind === 'turn.end' || payload.kind === 'step.end') {
      this.coalescer.drain()
    }
    if (payload.kind === 'text.delta' || payload.kind === 'reasoning.delta') {
      const key = sessionId + ':' + payload.turn + ':' + payload.step + ':' + payload.kind
      this.coalescer.push(key, { ...payload, sessionId })
      return
    }
    this.publish(OUTBOUND.TURN_EVENT, { ...payload, sessionId }, sessionId)
  }

  /**
   * Digest estável dos argumentos, para a regra "não perguntar de novo".
   * @param {unknown} args - argumentos analisados da ferramenta.
   * @returns {string} hash hex curto.
   */
  static digestArguments(args) {
    let serialized
    try {
      serialized = JSON.stringify(args ?? {})
    } catch {
      serialized = String(args)
    }
    return createHash('sha256').update(serialized).digest('hex').slice(0, 16)
  }

  /**
   * Procura uma regra que dispense a pergunta.
   * @param {string} sessionId - sessão do pedido.
   * @param {string} toolName - ferramenta pedida.
   * @param {string} digest - digest dos argumentos.
   * @returns {string|undefined} o desfecho gravado, se houver.
   */
  matchRule(sessionId, toolName, digest) {
    const list = this.rules.get(sessionId)
    if (!list) return undefined
    for (const rule of list) {
      if (rule.toolName !== toolName) continue
      if (rule.digest === '*' || rule.digest === digest) return rule.outcome
    }
    return undefined
  }

  /**
   * Grava uma regra para a sessão.
   * @param {string} sessionId - sessão alvo.
   * @param {string} toolName - ferramenta.
   * @param {string} digest - digest dos argumentos, ou '*' para qualquer um.
   * @param {string} outcome - desfecho a repetir.
   */
  addRule(sessionId, toolName, digest, outcome) {
    const list = this.rules.get(sessionId) ?? []
    list.push({ toolName, digest, outcome })
    this.rules.set(sessionId, list)
  }

  /**
   * Pede uma decisão ao celular e espera.
   *
   * Devolve `null` quando ninguém pode decidir — sem celular, sem assinante,
   * prazo estourado ou turno cancelado. O chamador trata `null` delegando ao
   * respondente normal, e é isso que mantém o fluxo antigo intacto.
   *
   * @param {object} input - dados do pedido.
   * @param {string} input.sessionId - sessão que pediu.
   * @param {string} input.toolName - ferramenta a autorizar.
   * @param {string} [input.callId] - chamada exata, quando houver.
   * @param {string} [input.reason] - explicação do pedido.
   * @param {unknown} [input.args] - argumentos já conhecidos da chamada.
   * @param {AbortSignal} [input.signal] - cancelamento do turno.
   * @param {number} input.timeoutMs - prazo máximo.
   * @param {(frame: object) => void} [input.onRequest] - avisado do pedido
   *   publicado, com o requestId. É o que permite RETIRAR o cartão do celular
   *   quando quem responder primeiro for a tela do PC.
   * @returns {Promise<string|null>} desfecho fechado do DSH, ou null para delegar.
   */
  async requestApproval(input) {
    if (this.phoneCount <= 0 || this.subscribers.size === 0) return null
    if (input.signal?.aborted) return null

    const digest = Hub.digestArguments(input.args)
    const remembered = this.matchRule(input.sessionId, input.toolName, digest)
    if (remembered) {
      this.counters.autoApproved += 1
      this.publish(OUTBOUND.APPROVAL_RESOLVED, {
        requestId: 'rule:' + digest,
        outcome: remembered,
        by: 'rule',
        toolName: input.toolName,
      }, input.sessionId)
      return remembered
    }

    const requestId = randomUUID()
    this.counters.approvals += 1
    const frame = {
      requestId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      callId: input.callId,
      reason: input.reason,
      args: input.args,
      digest,
      expiresAt: Date.now() + input.timeoutMs,
    }
    this.publish(OUTBOUND.APPROVAL_REQUEST, frame, input.sessionId)
    try {
      input.onRequest?.(frame)
    } catch { /* avisar quem chamou não pode derrubar o pedido */ }

    return new Promise((resolve) => {
      const settle = (outcome, by) => {
        const entry = this.pendingApprovals.get(requestId)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pendingApprovals.delete(requestId)
        if (input.signal) input.signal.removeEventListener('abort', onAbort)
        this.publish(OUTBOUND.APPROVAL_RESOLVED, {
          requestId,
          outcome: outcome ?? 'delegated',
          by,
          toolName: input.toolName,
        }, input.sessionId)
        resolve(outcome)
      }

      const onAbort = () => settle(null, 'cancelled')
      if (input.signal) input.signal.addEventListener('abort', onAbort, { once: true })

      const timer = setTimeout(() => {
        this.counters.timeouts += 1
        settle(null, 'timeout')
      }, input.timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      this.pendingApprovals.set(requestId, {
        resolve,
        timer,
        frame,
        toolName: input.toolName,
        sessionId: input.sessionId,
        digest,
        // Guardado para que o pedido possa ser RETIRADO de fora — é o que
        // acontece quando a tela do PC responde antes do celular.
        settle,
      })
    })
  }

  /**
   * Retira um pedido que está no celular porque outro respondeu primeiro.
   *
   * Sem isto o cartão fica na tela do celular até o prazo estourar, e quem
   * tocar nele depois recebe "pedido desconhecido" — o usuário vê uma fila que
   * mente. O desfecho fica lembrado, então um toque atrasado no celular é
   * reconhecido como repetição em vez de erro.
   *
   * @param {string} requestId - pedido a retirar.
   * @param {string} outcome - desfecho aplicado por quem respondeu.
   * @param {string} [by] - quem respondeu (vai no quadro de resolução).
   * @returns {boolean} se havia algo para retirar.
   */
  withdrawApproval(requestId, outcome, by = 'desktop') {
    const entry = this.pendingApprovals.get(String(requestId ?? ''))
    if (!entry) return false
    this.#rememberDecision(String(requestId), outcome === 'allowed-once' ? 'allowed-once' : 'rejected')
    entry.settle(outcome, by)
    return true
  }

  /**
   * Aplica a decisão vinda do celular.
   * @param {object} input - decisão recebida.
   * @param {string} input.requestId - pedido alvo.
   * @param {string} input.outcome - `allowed-once` ou `rejected`.
   * @param {boolean} [input.remember] - repetir a decisão nas próximas iguais.
   * @param {boolean} [input.rememberAll] - repetir para qualquer argumento.
   * @returns {{ok: boolean, error?: string}} resultado da aplicação.
   */
  decideApproval(input) {
    const requestId = String(input.requestId ?? '')

    // Idempotência obrigatória: o celular reenvia a decisão quando a rede cai
    // no meio. Um reenvio da MESMA decisão é sucesso, não erro — e uma decisão
    // CONTRÁRIA a uma já aplicada é recusada, porque a primeira já valeu.
    const previous = this.decided.get(requestId)
    if (previous !== undefined) {
      return previous === input.outcome
        ? { ok: true, duplicate: true, outcome: previous }
        : { ok: false, error: 'already-decided', outcome: previous }
    }

    const entry = this.pendingApprovals.get(requestId)
    if (!entry) return { ok: false, error: 'unknown-request' }
    const outcome = input.outcome === 'allowed-once' ? 'allowed-once' : 'rejected'
    this.#rememberDecision(requestId, outcome)
    if (input.remember || input.rememberAll) {
      this.addRule(entry.sessionId, entry.toolName, input.rememberAll ? '*' : entry.digest, outcome)
    }
    clearTimeout(entry.timer)
    this.pendingApprovals.delete(input.requestId)
    this.publish(OUTBOUND.APPROVAL_RESOLVED, {
      requestId: input.requestId,
      outcome,
      by: 'phone',
      toolName: entry.toolName,
    }, entry.sessionId)
    entry.resolve(outcome)
    return { ok: true, outcome }
  }

  /**
   * Guarda a decisão por um tempo, para reconhecer reenvios.
   * @param {string} requestId - pedido decidido.
   * @param {string} outcome - desfecho aplicado.
   */
  #rememberDecision(requestId, outcome) {
    this.decided.set(requestId, outcome)
    // Teto simples: o mapa não pode crescer sem limite numa sessão longa.
    if (this.decided.size > 500) this.decided.delete(this.decided.keys().next().value)
  }

  /**
   * Lista as aprovações pendentes — usado para reconstruir a tela ao reconectar.
   * @returns {object[]} os quadros pendentes.
   */
  listPending() {
    return [...this.pendingApprovals.values()].map((entry) => entry.frame)
  }

  /**
   * Pede uma resposta a uma pergunta feita pelo agente.
   * @param {object} input - dados da pergunta.
   * @param {string} input.sessionId - sessão que perguntou.
   * @param {object[]} input.questions - perguntas no formato do DSH.
   * @param {AbortSignal} [input.signal] - cancelamento.
   * @param {number} input.timeoutMs - prazo máximo.
   * @returns {Promise<object|null>} respostas, ou null quando ninguém respondeu.
   */
  async requestQuestion(input) {
    if (this.phoneCount <= 0 || this.subscribers.size === 0) return null
    if (input.signal?.aborted) return null
    const requestId = randomUUID()
    const frame = {
      requestId,
      sessionId: input.sessionId,
      questions: input.questions,
      expiresAt: Date.now() + input.timeoutMs,
    }
    this.publish(OUTBOUND.QUESTION_REQUEST, frame, input.sessionId)
    try {
      input.onRequest?.(frame)
    } catch { /* avisar quem chamou não pode derrubar a pergunta */ }
    return new Promise((resolve) => {
      const onAbort = () => settle(null)
      const settle = (answers) => {
        const entry = this.pendingQuestions.get(requestId)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pendingQuestions.delete(requestId)
        if (input.signal) input.signal.removeEventListener('abort', onAbort)
        resolve(answers)
      }
      if (input.signal) input.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => settle(null), input.timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pendingQuestions.set(requestId, { requestId, resolve: settle, timer, sessionId: input.sessionId })
    })
  }

  /**
   * Retira a pergunta do celular quando quem respondeu foi a tela do PC.
   *
   * Mesmo motivo da retirada de aprovacao: cartao respondido que continua na tela
   * e uma fila que mente, e quem tocar nele depois nao entende o silencio.
   *
   * @param {string} requestId - pergunta a retirar.
   * @param {string} [by] - quem respondeu.
   * @returns {boolean} se havia algo para retirar.
   */
  withdrawQuestion(requestId, by = 'desktop') {
    const entry = this.pendingQuestions.get(String(requestId ?? ''))
    if (!entry) return false
    entry.resolve(null)
    this.publish(OUTBOUND.QUESTION_RESOLVED, { requestId: String(requestId), by }, entry.sessionId)
    return true
  }

  /**
   * Aplica a resposta vinda do celular.
   * @param {{requestId: string, answers: object[]}} input - respostas recebidas.
   * @returns {{ok: boolean, error?: string}} resultado.
   */
  answerQuestion(input) {
    const entry = this.pendingQuestions.get(input.requestId)
    if (!entry) return { ok: false, error: 'unknown-request' }
    entry.resolve(input.answers ?? [])
    // Publica a resolucao TAMBEM quando quem respondeu foi o celular: sem isto a
    // pergunta resolvida nao chega aos outros clientes, e o cartao continua
    // respondivel na tela de quem ja respondeu.
    this.publish(OUTBOUND.QUESTION_RESOLVED, {
      requestId: String(input.requestId),
      by: 'phone',
      answers: input.answers ?? [],
    }, entry.sessionId)
    return { ok: true }
  }

  /** Resolve tudo o que está pendente — usado no desligamento. */
  shutdown() {
    this.coalescer.drain()
    for (const entry of this.pendingApprovals.values()) {
      clearTimeout(entry.timer)
      entry.resolve(null)
    }
    this.pendingApprovals.clear()
    for (const entry of this.pendingQuestions.values()) {
      clearTimeout(entry.timer)
      entry.resolve(null)
    }
    this.pendingQuestions.clear()
    this.decided.clear()
    this.subscribers.clear()
  }

  /** @returns {object} retrato do estado para o `/health`. */
  snapshot() {
    return {
      version: PROTOCOL_VERSION,
      seq: this.seq,
      uptimeMs: Date.now() - this.startedAt,
      sessions: this.sessions.size,
      subscribers: this.subscribers.size,
      phones: this.phoneCount,
      pendingApprovals: this.pendingApprovals.size,
      ringSize: this.ring.length,
      counters: { ...this.counters },
    }
  }
}
