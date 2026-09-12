/**
 * Protocolo PocketHound — vocabulário de quadros e projeção dos eventos do DSH.
 *
 * O que sai daqui é o que o celular vê. Um evento de sessão do Harness entra,
 * um quadro pequeno e estável sai. Nada de estrutura interna do DSH vaza para
 * o app: se o Harness mudar um campo, só este arquivo muda.
 *
 * @module dsh-pockethound/protocol
 */

/** Versão do protocolo. O celular recusa handshake com versão maior. */
export const PROTOCOL_VERSION = 1

/** Teto de caracteres por campo de texto num quadro — protege o rádio. */
export const MAX_TEXT = 12000

/**
 * Recorta texto longo para caber num quadro, marcando o corte.
 * @param {string} text - texto original.
 * @param {number} [limit] - teto de caracteres.
 * @returns {string} texto possivelmente cortado.
 */
export function clip(text, limit = MAX_TEXT) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  const removed = value.length - limit
  return value.slice(0, limit) + '\n\n[… ' + removed + ' caracteres omitidos …]'
}

/**
 * Concatena os blocos de texto de um conteúdo de mensagem.
 * @param {unknown} content - lista de ContentBlock do DSH.
 * @returns {string} texto plano.
 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Concatena os blocos de raciocínio de um conteúdo de mensagem.
 * @param {unknown} content - lista de ContentBlock do DSH.
 * @returns {string} texto de raciocínio.
 */
export function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'reasoning' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Extrai as chamadas de ferramenta embutidas num conteúdo de assistente.
 * @param {unknown} content - lista de ContentBlock do DSH.
 * @returns {Array<{id: string, name: string, arguments: string}>} chamadas encontradas.
 */
export function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block && block.type === 'tool-call') {
      out.push({ id: String(block.id), name: String(block.name), arguments: String(block.arguments ?? '') })
    }
  }
  return out
}

/**
 * Tenta ler os argumentos de uma ferramenta como objeto.
 * O modelo emite JSON cru; um JSON quebrado não pode derrubar a ponte.
 * @param {string} raw - argumentos como o modelo produziu.
 * @returns {unknown} objeto analisado, ou o texto cru quando não é JSON.
 */
export function parseArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: clip(raw, 4000) }
  }
}

/** Tipos de quadro que o PC envia ao celular. */
export const OUTBOUND = Object.freeze({
  HELLO: 'hello',
  SESSION_UPSERT: 'session.upsert',
  SESSION_GONE: 'session.gone',
  TURN_EVENT: 'turn.event',
  APPROVAL_REQUEST: 'approval.request',
  APPROVAL_RESOLVED: 'approval.resolved',
  QUESTION_REQUEST: 'question.request',
  /** A pergunta foi respondida em outro lugar: o cartão do celular sai da tela. */
  QUESTION_RESOLVED: 'question.resolved',
  DESK_STATE: 'desk.state',
  NOTICE: 'notice',
  PONG: 'pong',
  REPLAY_DONE: 'replay.done',
})

/** Tipos de quadro que o celular envia ao PC. */
export const INBOUND = Object.freeze({
  HELLO_ACK: 'hello.ack',
  SUBSCRIBE: 'subscribe',
  PROMPT_SEND: 'prompt.send',
  APPROVAL_DECIDE: 'approval.decide',
  QUESTION_ANSWER: 'question.answer',
  SESSION_CANCEL: 'session.cancel',
  SESSION_SELECT: 'session.select',
  PING: 'ping',
})

/**
 * Projeta um evento do log de sessão do DSH num quadro `turn.event`.
 *
 * Devolve `null` para tudo que não interessa ao celular (marcadores internos,
 * cabeçalhos de requisição, auditoria). Silêncio é a resposta certa para o que
 * o humano não precisa ver.
 *
 * @param {object} event - SessionEvent do DSH (`{ type, seq, time, data }`).
 * @returns {object|null} payload do quadro, ou null quando irrelevante.
 */
export function projectSessionEvent(event) {
  if (!event || typeof event.type !== 'string') return null
  const data = event.data ?? {}
  switch (event.type) {
    case 'turn/start':
      return { kind: 'turn.start', turn: data.turn, at: event.time }

    case 'turn/end':
      return { kind: 'turn.end', turn: data.turn, reason: data.reason, at: event.time }

    case 'step/start':
      return { kind: 'step.start', turn: data.turn, step: data.step }

    case 'step/end':
      return { kind: 'step.end', turn: data.turn, step: data.step }

    case 'user/message': {
      const text = textOf(data.content)
      if (!text) return null
      return {
        kind: 'user.message',
        at: event.time,
        text: clip(text),
        source: data.source?.kind ?? 'user',
        plugin: data.source?.plugin,
      }
    }

    case 'assistant/chunk': {
      const chunk = data.chunk
      if (!chunk) return null
      if (chunk.type === 'text-delta') {
        return { kind: 'text.delta', turn: data.turn, step: data.step, index: chunk.index, text: chunk.text }
      }
      if (chunk.type === 'reasoning-delta') {
        return { kind: 'reasoning.delta', turn: data.turn, step: data.step, index: chunk.index, text: chunk.text }
      }
      return null
    }

    case 'assistant/message': {
      const message = data.message ?? {}
      const text = textOf(message.content)
      const reasoning = reasoningOf(message.content)
      const calls = toolCallsOf(message.content)
      if (!text && !reasoning && calls.length === 0) return null
      return {
        kind: 'text.done',
        turn: data.turn,
        step: data.step,
        at: event.time,
        text: clip(text),
        reasoning: reasoning ? clip(reasoning) : undefined,
        calls: calls.map((call) => ({ callId: call.id, name: call.name, args: parseArguments(call.arguments) })),
        usage: data.usage
          ? { input: data.usage.inputTokens, output: data.usage.outputTokens, total: data.usage.totalTokens }
          : undefined,
      }
    }

    case 'tool/call':
      return {
        kind: 'tool.call',
        turn: data.turn,
        step: data.step,
        at: event.time,
        callId: String(data.callId),
        name: String(data.name),
        args: parseArguments(data.arguments),
      }

    case 'tool/result': {
      const message = data.message ?? {}
      const block = Array.isArray(message.content) ? message.content[0] : undefined
      const inner = block && Array.isArray(block.content) ? block.content : []
      return {
        kind: 'tool.result',
        turn: data.turn,
        step: data.step,
        at: event.time,
        callId: String(block?.toolCallId ?? ''),
        isError: Boolean(data.error) || Boolean(block?.isError),
        errorCode: data.error?.code,
        text: clip(textOf(inner), 4000),
      }
    }

    // Fila do proximo turno. Spliced so diz o DELTA (entrou X, saiu Y); o hub
    // transforma isso no tamanho absoluto da fila antes de publicar. E o numero
    // que responde "meu prompt entrou na fila?" quando a sessao esta ocupada.
    case 'agent/inbox/spliced': {
      if (data.target !== 'next-turn') return null
      const inserted = Array.isArray(data.inserted) ? data.inserted.length : 0
      const removed = Number(data.removedCount) || 0
      return { kind: 'inbox', inserted, removed, at: event.time }
    }

    case 'todo/write':
      return {
        kind: 'todo.write',
        at: event.time,
        todos: Array.isArray(data.todos)
          ? data.todos.map((todo) => ({ content: String(todo?.content ?? ''), status: String(todo?.status ?? 'pending') }))
          : [],
      }

    default:
      return null
  }
}
