/**
 * dsh-pockethound — metade host do PocketHound.
 *
 * O que este plugin faz dentro do Harness:
 *
 *   1. Observa TODAS as sessões vivas (`session/event`) e projeta o fluxo num
 *      protocolo enxuto para o celular — texto digitando ao vivo, raciocínio,
 *      chamadas de ferramenta, resultados, listas de tarefas.
 *   2. Entra no waterfall `approval/request` e deixa o CELULAR decidir. Sem
 *      celular conectado ele chama `next()` e a decisão volta ao respondente
 *      normal: nada do fluxo atual muda quando o app está fechado.
 *   3. Sobe uma ponte HTTP só de loopback que o app PocketHound desk consome.
 *   4. Dá ao agente duas ferramentas para falar com você: notificar e perguntar.
 *
 * @module dsh-pockethound
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Bridge } from './bridge.js'
import { Hub } from './hub.js'
import { projectSessionEvent, OUTBOUND } from './protocol.js'

const name = 'pockethound'

// Sem dependência obrigatória: o plugin ativa em QUALQUER perfil (web,
// headless, futuros). Tudo que precisa de um serviço específico entra em
// `ctx.inject`, que só roda onde o serviço existir — declarar aqui deixaria a
// entry pendente e o boot do harness falha nesse caso.
const inject = []

const Config = z.object({
  /** Liga a ponte. Desligado, o plugin não faz absolutamente nada. */
  enabled: z.boolean().default(true),
  /** Interface de escuta. Loopback por decisão de projeto — não mude sem motivo. */
  host: z.string().default('127.0.0.1'),
  /** Porta. 0 deixa o sistema escolher uma livre. */
  port: z.number().default(0),
  /** Onde publicar o anúncio da ponte. Vazio = `$DSH_HOME/pockethound/bridge.json`. */
  statePath: z.string().default(''),
  /** Reivindicar os pedidos de aprovação para o celular. */
  claimApprovals: z.boolean().default(true),
  /**
   * Deixar o celular e a tela do PC verem o pedido AO MESMO TEMPO.
   *
   * Antes o celular segurava a pergunta com exclusividade e só depois do prazo
   * estourado é que a tela do PC perguntava — quem estava no PC esperava 90 s
   * por uma pergunta que já tinha resposta disponível. Agora as duas telas
   * perguntam juntas e a PRIMEIRA resposta vale; quando o PC responde, o cartão
   * do celular é retirado na hora. Desligue para voltar ao comportamento antigo.
   */
  shareWithDesktop: z.boolean().default(true),
  /** Reivindicar as perguntas de `ask_user_question` quando ninguém mais as atende. */
  claimQuestions: z.boolean().default(true),
  /** Prazo para o celular decidir uma aprovação, em ms. No estouro, delega. */
  approvalTimeoutMs: z.number().default(90000),
  /** Prazo para o celular responder uma pergunta, em ms. */
  questionTimeoutMs: z.number().default(300000),
  /** Janela de agrupamento dos deltas de texto, em ms. */
  coalesceMs: z.number().default(40),
  /** Quantos quadros guardar para replay após uma reconexão. */
  replayLimit: z.number().default(4000),
  /** Registra as ferramentas `pockethound_notify` e `pockethound_ask`. */
  registerTools: z.boolean().default(true),
  /**
   * Deixa o celular continuar uma sessão que não está viva.
   *
   * Sessão viva é a que tem agente rodando agora. Uma conversa de ontem está só
   * no disco — sem isto, mandar um prompt para ela devolve "não encontrada" e
   * você não consegue retomar nada pelo celular.
   */
  allowResume: z.boolean().default(true),
  /**
   * Inclui sessões de subagente na lista.
   *
   * Elas existem (o Harness delega muito) e têm valor de diagnóstico, mas são
   * MUITAS e emitem muito evento. Ficam marcadas com `origin: 'subagent'` e
   * `depth`, e o celular decide o que mostrar.
   */
  includeSubagents: z.boolean().default(true),
  /** Escreve diagnóstico no stderr. */
  debug: z.boolean().default(false),
})

/**
 * Resolve o caminho do arquivo de anúncio.
 * @param {string} configured - valor vindo da configuração.
 * @returns {string} caminho absoluto do anúncio.
 */
function resolveStatePath(configured) {
  if (configured) return configured
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'pockethound', 'bridge.json')
}

/**
 * Monta o plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - contexto do harness.
 * @param {object} config - configuração já validada pelo Loader.
 */
function apply(ctx, config) {
  if (!config.enabled) return

  const log = config.debug
    ? (message) => process.stderr.write('[pockethound] ' + message + '\n')
    : () => {}

  const hub = new Hub({
    replayLimit: config.replayLimit,
    coalesceMs: config.coalesceMs,
    approvalTimeoutMs: config.approvalTimeoutMs,
  })

  /**
   * Retrato das sessões vivas, para \`GET /sessions\` e para o \`hello\`.
   * @returns {object[]} sessões conhecidas.
   */
  /**
   * Lista as sessões: as vivas agora, mais o corpus que está só no disco.
   *
   * Só as vivas não bastam. O harness reinicia, e as sessões de ontem somem da
   * lista — mas elas continuam existindo no log, e com `allowResume` o celular
   * consegue retomá-las. Mostrar só o que está aberto no PC seria esconder
   * metade do que o app deveria alcançar.
   *
   * @returns {Promise<object[]>} sessões, vivas primeiro.
   */
  const listSessions = async () => {
    const merged = new Map()
    /** Cabeçalhos por id — só para localizar o log; nunca vão para o celular. */
    const headers = new Map()

    for (const session of hub.sessions.values()) merged.set(session.id, session)

    try {
      const query = servico(ctx, 'sessionQuery')
      if (query) {
        for (const record of await query.listSessions()) {
          const id = String(record.header?.id ?? '')
          if (!id) continue
          headers.set(id, record.header)
          if (merged.has(id)) continue
          if (!config.includeSubagents && record.header?.origin === 'subagent') continue
          merged.set(id, {
            id,
            title: '',
            workspace: record.header?.cwd ?? '',
            status: record.live ? 'live' : 'cold',
            origin: record.header?.origin,
            depth: record.header?.delegationDepth,
            createdAt: record.header?.createdAt,
          })
        }
      }
    } catch (error) {
      // Sem o corpus, a lista sai só com as vivas — degrada, não quebra.
      log('corpus de sessões indisponível: ' + (error?.message ?? error))
    }

    if (!config.includeSubagents) {
      for (const [id, session] of merged) {
        if (session.origin === 'subagent' && session.status !== 'live') merged.delete(id)
      }
    }

    return [...merged.values()]
      .map((session) => {
        const caminho = localizarLog(ctx, headers.get(session.id))
        return caminho ? { ...session, logPath: caminho } : session
      })
      .sort((a, b) => {
        if ((a.status === 'live') !== (b.status === 'live')) return a.status === 'live' ? -1 : 1
        return (b.lastSeen ?? b.createdAt ?? 0) - (a.lastSeen ?? a.createdAt ?? 0)
      })
  }

  /* ------------------------------------------------------------ sessões */

  ctx.effect(() => {
    const onCreated = (session) => {
      hub.sessionUpsert(describeSession(session))
    }
    const onDisposed = (session) => {
      hub.sessionGone(String(session.id))
    }
    const onEvent = (session, event) => {
      const id = String(session.id)
      const payload = projectSessionEvent(event)
      if (!payload) return
      hub.sessionUpsert(describeSession(session))
      hub.publishTurnEvent(id, payload)
    }
    const offCreated = ctx.on('session/created', onCreated)
    const offDisposed = ctx.on('session/disposed', onDisposed)
    const offEvent = ctx.on('session/event', onEvent)
    // Sessões que já existiam quando o plugin montou (recarga a quente).
    ctx.inject(['sessions'], (scope) => {
      for (const session of scope.sessions.list()) hub.sessionUpsert(describeSession(session))
    })
    return () => {
      offCreated?.()
      offDisposed?.()
      offEvent?.()
    }
  }, 'pockethound: observa as sessões')

  /* --------------------------------------------------------- aprovações */

  ctx.effect(() => {
    const off = ctx.on('approval/request', async (request, next) => {
      if (!config.claimApprovals) return next()
      try {
        /** @type {string|undefined} */
        let requestId
        const doCelular = hub.requestApproval({
          sessionId: String(request.agent?.id ?? ''),
          toolName: String(request.toolName ?? ''),
          callId: request.callId ? String(request.callId) : undefined,
          reason: request.reason,
          args: argumentsForApproval(ctx, request),
          signal: request.signal,
          timeoutMs: config.approvalTimeoutMs,
          onRequest: (frame) => { requestId = frame.requestId },
        })

        if (!config.shareWithDesktop) {
          // Comportamento antigo: o celular responde sozinho, e só no estouro a
          // pergunta segue para o respondente normal.
          const so = await doCelular
          return so ?? next()
        }

        // A MESMA pergunta vai para a tela do PC agora, não daqui a 90 s.
        const doPc = Promise.resolve(next()).then((outcome) => ({ outcome, quem: 'pc' }))
        // `null` é "ninguém decidiu no celular" (sem aparelho, prazo estourado,
        // turno cancelado): não pode vencer a corrida, senão o pedido morreria
        // sem que a tela do PC tivesse chance de perguntar.
        const doFone = doCelular.then((outcome) =>
          outcome === null || outcome === undefined
            ? new Promise(() => {})
            : { outcome, quem: 'celular' })

        const vencedor = await Promise.race([doPc, doFone])
        if (vencedor.quem === 'pc') {
          // Quem respondeu foi o PC: o cartão do celular sai da tela agora, em
          // vez de ficar mentindo até o prazo estourar.
          if (requestId) hub.withdrawApproval(requestId, vencedor.outcome, 'desktop')
          return vencedor.outcome
        }
        return vencedor.outcome
      } catch (error) {
        log('falha ao pedir aprovação: ' + error)
        return next()
      }
    })
    return () => off?.()
  }, 'pockethound: aprovações no celular e no PC ao mesmo tempo')

  /* ---------------------------------------------------------- perguntas */

  // O seam `userQuestions` aceita UM provedor por contexto. O harness web já
  // registra o dele, então só assumimos quando o assento está vago (perfis
  // headless). Nunca deslocamos uma UI que já funciona.
  ctx.effect(() => {
    if (!config.claimQuestions) return
    let dispose
    ctx.inject(['userQuestions'], (scope) => {
      // A UI web não tolera o assento ocupado: o construtor dela registra o
      // provedor e lança se já houver um — derrubando o boot inteiro. E ela
      // monta DEPOIS daqui (depende de muito mais serviços), então o try/catch
      // abaixo, sozinho, não a salva. Decidimos pelo que a árvore do Loader
      // declara, e não pela ordem em que os plugins ativam.
      if (webOwnsQuestions(scope)) return
      try {
        dispose = scope.userQuestions.registerProvider({
          ask: async (request) => {
            const answers = await hub.requestQuestion({
              sessionId: String(request.agent?.id ?? ''),
              questions: request.questions,
              signal: request.signal,
              timeoutMs: config.questionTimeoutMs,
            })
            if (answers === null) throw new Error('PocketHound: nenhum celular respondeu')
            return { answers }
          },
        })
      } catch {
        // Já existe um provedor (a UI do navegador). Seguimos sem registrar.
        dispose = undefined
      }
    })
    return () => dispose?.()
  }, 'pockethound: perguntas no celular (quando vago)')

  /* ------------------------------------------------------------ comandos */

  /**
   * Entrega um prompt do celular a uma sessão viva.
   * @param {object} input - pedido recebido da ponte.
   * @returns {Promise<object>} resultado da entrega.
   */
  const onPrompt = async (input) => {
    const sessionId = String(input.sessionId ?? '')
    const text = String(input.text ?? '').trim()
    if (!text) return { ok: false, error: 'texto vazio' }
    const target = await resolveAgentForPrompt(ctx, sessionId, config.allowResume, log)
    if (!target) return { ok: false, error: 'sessão não encontrada: ' + sessionId }
    const message = buildUserMessage(text)
    if (input.mode === 'steer') target.steer(message)
    else target.followup(message)
    return { ok: true, sessionId, mode: input.mode === 'steer' ? 'steer' : 'followup' }
  }

  /**
   * Cancela o turno ativo de uma sessão.
   * @param {string} sessionId - sessão alvo.
   * @param {string} cause - motivo estável.
   * @returns {boolean} se a sessão existia.
   */
  const onCancel = (sessionId, cause) => {
    const target = resolveAgent(ctx, sessionId)
    if (!target) return false
    target.cancel(cause)
    return true
  }

  /* -------------------------------------------------------------- ponte */

  const bridge = new Bridge({
    hub,
    config,
    onPrompt,
    onCancel,
    listSessions,
    statePath: resolveStatePath(config.statePath),
    log,
  })

  ctx.effect(() => {
    bridge.start()
    return () => {
      hub.shutdown()
      bridge.stop()
    }
  }, 'pockethound: ponte de loopback')

  /* --------------------------------------------------------- ferramentas */

  if (config.registerTools) {
    ctx.effect(() => {
      let dispose
      ctx.inject(['tools'], (scope) => {
        const off1 = scope.tools.register(defineNotifyTool(defineTool, hub))
        const off2 = scope.tools.register(defineAskTool(defineTool, hub))
        dispose = () => {
          off1?.()
          off2?.()
        }
      })
      return () => dispose?.()
    }, 'pockethound: ferramentas do agente')
  }
}

/* ------------------------------------------------------------- auxiliares */

/**
 * A UI web é dona do assento de `userQuestions`.
 *
 * O host `api-gateway` (`@deepseek-ai/dsh-host-apiproxy`) registra o provedor no
 * construtor e NÃO tolera o assento ocupado: `registerProvider` lança e derruba
 * o boot. Como o PocketHound monta antes (a UI depende de muitos mais serviços),
 * tentar/capturar na hora do registro não basta — é preciso saber de antemão se
 * ela está na árvore. O Loader já criou todas as entries quando qualquer plugin
 * monta, então decidimos pelo que está declarado, sem depender da ordem de
 * ativação. O teste do serviço `apiProxy` cobre o caso de ela já ter ativado.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - contexto do harness.
 * @returns {boolean} se uma UI web/api-proxy está montada nesta árvore.
 */
function webOwnsQuestions(ctx) {
  try {
    if (typeof ctx.get === 'function' && ctx.get('apiProxy') !== undefined) return true
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
    if (!loader || typeof loader.entries !== 'function') return false
    for (const entry of loader.entries()) {
      if (entry?.disabled) continue
      if (entry?.options?.name === '@deepseek-ai/dsh-host-apiproxy') return true
    }
  } catch { /* sem Loader visível: cai no try/catch do registro */ }
  return false
}

/**
 * Descreve uma sessão para o celular.
 * @param {object} session - sessão do DSH.
 * @returns {object} retrato enxuto.
 */
function describeSession(session) {
  const id = String(session.id)
  let title = ''
  let workspace = ''
  try {
    for (const event of session.events ?? []) {
      if (event.type === 'user/message' && !title) {
        const content = event.data?.content ?? []
        const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
        if (text) title = text.slice(0, 120)
      }
      if (event.type === 'request/header' && !workspace) {
        workspace = String(event.data?.header?.cwd ?? event.data?.header?.workspace ?? '')
      }
      if (title && workspace) break
    }
  } catch { /* sessão recém-criada pode não ter log legível */ }
  const header = session.header ?? {}
  return {
    id,
    title,
    workspace: workspace || header.cwd || '',
    status: 'live',
    events: (session.events ?? []).length,
    // Origin e profundidade permitem ao celular separar o que é conversa sua
    // do que é subagente trabalhando em segundo plano — o volume é bem
    // diferente, e o harness delega muito.
    origin: header.origin,
    depth: header.delegationDepth,
    createdAt: header.createdAt,
  }
}

/**
 * Descobre o arquivo de log de uma sessão pela API canônica do harness.
 *
 * `ctx.sessionPersistence.locate(header)` devolve o caminho **sem tocar no
 * filesystem** — montar o caminho na mão exigiria reimplementar `projectKey` e
 * `encodeSegment`, que escapam o espaço como `~0020` e truncam em 251 chars.
 * Não vale a pena apostar nisso.
 *
 * O conteúdo do arquivo é JSONL **comprimido em zstd e com runs de
 * `assistant/chunk` empacotados** em linhas `text-chunks`/`reasoning-chunks`/
 * `tool-call-chunks` — ler na mão é propenso a erro. Aqui só entregamos o
 * caminho para o humano abrir; quem for ler de verdade deve usar
 * `sessionPersistence.readRaw()`, que descomprime e decodifica.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - contexto do harness.
 * @param {object|undefined} header - cabeçalho da sessão.
 * @returns {string|undefined} caminho do arquivo, quando conhecido.
 */
function localizarLog(ctx, header) {
  try {
    const persistencia = servico(ctx, 'sessionPersistence')
    if (!header || !persistencia) return undefined
    return persistencia.locate(header)?.path
  } catch {
    return undefined
  }
}

/**
 * Procura o agente vivo de uma sessão.
 * @param {import('@deepseek-ai/cordis').Context} ctx - contexto do harness.
 * @param {string} sessionId - identificador da sessão.
 * @returns {object|undefined} o agente, quando vivo.
 */
function resolveAgent(ctx, sessionId) {
  try {
    const agents = servico(ctx, 'agents')
    if (!agents || !sessionId) return undefined
    return agents.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Pega um serviço do harness, por propriedade OU por `ctx.get`.
 *
 * Isto não é zelo: `ctx.agents` (acesso por propriedade) só resolve quando o
 * serviço está no mesmo escopo do contexto. O plugin é montado pela camada do
 * usuário (`cordis.patch.yml`), e ali a propriedade vem `undefined` — sem
 * erro e sem aviso, porque quem lê costuma estar dentro de um try/catch.
 *
 * O sintoma era cruel: `/prompt` respondia "sessão não encontrada" para uma
 * sessão que a própria ponte listava como viva, e a lista nunca trazia o corpus
 * do disco. Dois serviços invisíveis pelo mesmo motivo.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - contexto do harness.
 * @param {string} nome - nome do serviço (`agents`, `sessionQuery`...).
 * @returns {unknown} o serviço, quando existir.
 */
function servico(ctx, nome) {
  try {
    const porPropriedade = ctx[nome]
    if (porPropriedade !== undefined) return porPropriedade
  } catch { /* acesso por propriedade pode nao existir fora de escopo */ }
  try {
    return typeof ctx.get === 'function' ? ctx.get(nome) : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve o agente de uma sessão, **resumindo do disco quando ela estiver fria**.
 *
 * Sessão viva é a que tem agente rodando neste processo. Uma conversa de ontem
 * está só no log em disco. Sem o resume, mandar um prompt para ela devolveria
 * "não encontrada" e o celular não conseguiria continuar nada que não estivesse
 * aberto no PC — que é justamente o caso de uso.
 *
 * O `handle` devolvido por `resume` é uma capacidade: quem cria é dono do
 * teardown. O próprio resolver do harness nunca descarta os resumes que faz (a
 * sessão fica viva), e seguimos o mesmo caminho — a sessão some quando o
 * processo termina.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - contexto do harness.
 * @param {string} sessionId - identificador da sessão.
 * @param {boolean} allowResume - se pode carregar do disco.
 * @param {(message: string) => void} log - registrador.
 * @returns {Promise<object|undefined>} o agente, quando disponível.
 */
async function resolveAgentForPrompt(ctx, sessionId, allowResume, log) {
  const live = resolveAgent(ctx, sessionId)
  if (live) return live
  if (!allowResume || !sessionId) return undefined
  const agents = servico(ctx, 'agents')
  if (!agents) {
    log('serviço "agents" invisível neste contexto — não dá para retomar ' + sessionId)
    return undefined
  }
  try {
    const handle = await agents.resume({ resumeSessionId: sessionId })
    if (handle?.agent) {
      log('sessão ' + sessionId + ' estava fria; resumida do disco')
      return handle.agent
    }
  } catch (error) {
    // Resumir exige persistência configurada; sem ela o perfil não tem disco.
    log('não consegui resumir ' + sessionId + ': ' + (error?.message ?? error))
  }
  return undefined
}

/**
 * Cria a mensagem de usuário que o DSH aceita no inbox.
 * @param {string} text - texto do prompt.
 * @returns {object} mensagem identificada e congelada.
 */
function buildUserMessage(text) {
  // A fábrica do harness gera a identidade no formato que o log espera e
  // congela a mensagem antes de publicá-la. Um id caseiro funcionaria hoje e
  // quebraria na primeira mudança de formato.
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * Recupera os argumentos já apresentados da chamada que originou a aprovação.
 *
 * O pedido de aprovação não carrega os argumentos (o DSH evita duplicá-los: o
 * `callId` aponta para a chamada já transmitida). Aqui relemos o log da sessão
 * para achar aquele `tool/call` e mandar o contexto ao celular — sem isso o
 * humano decide às cegas.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - contexto do harness.
 * @param {object} request - pedido de aprovação do DSH.
 * @returns {unknown} argumentos analisados, ou undefined.
 */
function argumentsForApproval(ctx, request) {
  try {
    const session = request.agent?.session
    const callId = request.callId
    if (!session || !callId) return undefined
    const events = session.events ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type === 'tool/call' && String(event.data?.callId) === String(callId)) {
        const raw = event.data?.arguments
        try {
          return JSON.parse(raw)
        } catch {
          return { _raw: String(raw).slice(0, 4000) }
        }
      }
    }
  } catch { /* log indisponível: segue sem os argumentos */ }
  return undefined
}

/**
 * Define a ferramenta que manda uma notificação para o celular.
 * @param {Function} defineTool - fábrica de ferramentas do DSH.
 * @param {import('./hub.js').Hub} hub - hub do plugin.
 * @returns {object} definição da ferramenta.
 */
function defineNotifyTool(defineTool, hub) {
  return defineTool({
    name: 'pockethound_notify',
    description:
      'Send a short notification to the user\'s phone through PocketHound. Use it to report that a long task finished, a build broke, or something needs attention soon. It does not wait for a reply — use pockethound_ask when you need an answer.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short headline, under 60 characters.' },
      body: { type: 'string', description: 'One or two sentences of detail.' },
      level: {
        type: 'string',
        description: 'Severity: info, success, warn or error. Defaults to info.',
        enum: ['info', 'success', 'warn', 'error'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          phones: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const delivered = hub.phoneCount > 0 && hub.subscriberCount > 0
      if (delivered) {
        hub.publish(OUTBOUND.NOTICE, {
          level: args.level ?? 'info',
          title: String(args.title ?? ''),
          body: String(args.body ?? ''),
          at: Date.now(),
        })
      }
      return { delivered, phones: hub.phoneCount }
    },
  })
}

/**
 * Define a ferramenta que faz uma pergunta e espera a resposta do celular.
 * @param {Function} defineTool - fábrica de ferramentas do DSH.
 * @param {import('./hub.js').Hub} hub - hub do plugin.
 * @returns {object} definição da ferramenta.
 */
function defineAskTool(defineTool, hub) {
  return defineTool({
    name: 'pockethound_ask',
    description:
      'Ask the user a question on their phone through PocketHound and wait for the answer. Use it when you are blocked and only the human can decide. Fails fast when no phone is connected, so always have a fallback plan.',
    parameters: {
      question: { type: 'string', required: true, description: 'The question to show on the phone.' },
      header: { type: 'string', description: 'Optional short heading.' },
      options: {
        type: 'array',
        description: 'Optional choices. Put the recommended one first.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            label: { type: 'string', required: true },
            description: { type: 'string' },
          },
        },
      },
      timeoutSeconds: { type: 'number', description: 'How long to wait. Defaults to 300.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answered: { type: 'boolean', required: true },
          selected: { type: 'array', required: true, items: { type: 'string' } },
          custom: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const timeoutMs = Math.max(15, Math.min(1800, Number(args.timeoutSeconds) || 300)) * 1000
      const answers = await hub.requestQuestion({
        sessionId: String(exec?.agent?.id ?? ''),
        questions: [
          {
            id: 'q1',
            question: String(args.question ?? ''),
            ...(args.header !== undefined ? { header: args.header } : {}),
            ...(args.options !== undefined ? { options: args.options } : {}),
          },
        ],
        signal: exec?.signal,
        timeoutMs,
      })
      const answer = Array.isArray(answers) ? answers[0] : undefined
      return {
        answered: Boolean(answer),
        selected: Array.isArray(answer?.selected) ? answer.selected : [],
        ...(answer?.custom !== undefined ? { custom: answer.custom } : {}),
      }
    },
  })
}

export { Config, apply, inject, name }
