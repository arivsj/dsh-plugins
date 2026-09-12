/**
 * Ponte — servidor HTTP de loopback que o PocketHound desk consome.
 *
 * Escuta APENAS em 127.0.0.1 e exige um token efêmero gerado a cada boot do
 * DSH. O token é publicado em \`~/.dsh/pockethound/bridge.json\` (modo 0600)
 * junto da porta, para o app do PC descobrir a ponte sem configuração.
 *
 * Nada aqui conhece celular, relay ou rede externa: quem fala com o mundo é o
 * app do PC. Isso mantém o plugin leve e o Harness nunca exposto.
 *
 * @module dsh-pockethound/bridge
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { OUTBOUND, PROTOCOL_VERSION } from './protocol.js'

/** Teto de corpo aceito nas rotas POST — quadros são pequenos por natureza. */
const MAX_BODY = 256 * 1024

/**
 * Lê o corpo JSON de uma requisição, com teto de tamanho.
 * @param {import('node:http').IncomingMessage} req - requisição.
 * @returns {Promise<object>} objeto analisado (vazio quando não há corpo).
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('corpo grande demais'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) { resolve({}); return }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Compara dois segredos sem vazar o tempo de comparação.
 * @param {string} a - primeiro valor.
 * @param {string} b - segundo valor.
 * @returns {boolean} se são iguais.
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Ponte de loopback entre o plugin e o app PocketHound desk. */
export class Bridge {
  /**
   * @param {object} options - dependências e configuração.
   * @param {import('./hub.js').Hub} options.hub - hub de estado.
   * @param {object} options.config - configuração resolvida do plugin.
   * @param {(input: object) => Promise<object>} options.onPrompt - envio de prompt a uma sessão.
   * @param {(sessionId: string, cause: string) => boolean} options.onCancel - cancelamento de turno.
   * @param {() => object[]} options.listSessions - retrato das sessões.
   * @param {string} options.statePath - caminho do arquivo de anúncio.
   * @param {(message: string) => void} [options.log] - registrador.
   */
  constructor(options) {
    this.hub = options.hub
    this.config = options.config
    this.onPrompt = options.onPrompt
    this.onCancel = options.onCancel
    this.listSessions = options.listSessions
    this.statePath = options.statePath
    this.log = options.log ?? (() => {})
    this.token = randomBytes(32).toString('hex')
    this.server = null
    this.port = 0
  }

  /** Sobe o servidor de loopback e publica o arquivo de anúncio. */
  start() {
    this.#bind(this.config.port, false)
  }

  /**
   * Cria o servidor e tenta escutar.
   *
   * O tratamento de `'error'` aqui NÃO é zelo excessivo: em Node, um evento
   * `'error'` sem listener é lançado como exceção. Sem este handler, uma porta
   * ocupada (`EADDRINUSE`) subiria como exceção não tratada DENTRO do processo
   * do harness — ou seja, um conflito de porta derrubaria o DSH inteiro. Um
   * plugin de conveniência não pode ter esse poder.
   *
   * @param {number} port - porta pedida (0 = livre).
   * @param {boolean} jaTentou - se esta já é a segunda tentativa.
   */
  #bind(port, jaTentou) {
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.#json(res, 500, { error: { code: 'INTERNAL', message: String(error?.message ?? error) } })
      })
    })
    this.server.on('clientError', (_error, socket) => socket.destroy())
    this.server.on('error', (error) => {
      if (error?.code === 'EADDRINUSE' && port !== 0 && !jaTentou) {
        this.log('porta ' + port + ' ocupada — pedindo uma livre ao sistema')
        try { this.server.close() } catch { /* já fechando */ }
        this.#bind(0, true)
        return
      }
      // Qualquer outro erro: registrar e seguir vivo. A ponte fica indisponível
      // e o app do PC mostra isso; o harness continua funcionando.
      this.failure = error?.code ?? 'erro'
      this.log('ponte indisponível: ' + (error?.message ?? error))
      this.onFailure?.(error)
    })
    this.server.listen(port, this.config.host, () => {
      const address = this.server.address()
      this.port = typeof address === 'object' && address ? address.port : port
      this.failure = undefined
      this.#announce()
      this.log('ponte escutando em http://' + this.config.host + ':' + this.port)
    })
  }

  /** Encerra o servidor e remove o anúncio. */
  stop() {
    try {
      unlinkSync(this.statePath)
    } catch { /* o arquivo pode já ter sumido — não é erro */ }
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  /** @returns {object} descrição da ponte para logs e para o app. */
  describe() {
    return {
      version: PROTOCOL_VERSION,
      host: this.config.host,
      port: this.port,
      pid: process.pid,
      statePath: this.statePath,
      subscribers: this.hub.subscriberCount,
      ...(this.failure ? { failure: this.failure } : {}),
    }
  }

  /** Escreve o arquivo de anúncio de forma atômica e restritiva. */
  #announce() {
    const payload = {
      version: PROTOCOL_VERSION,
      plugin: 'dsh-pockethound',
      host: this.config.host,
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      harness: process.env.DSH_VERSION ?? null,
    }
    mkdirSync(dirname(this.statePath), { recursive: true })
    const temporary = this.statePath + '.tmp'
    writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 })
    renameSync(temporary, this.statePath)
    try {
      chmodSync(this.statePath, 0o600)
    } catch { /* sistemas sem permissão POSIX: o arquivo continua válido */ }
  }

  /**
   * Responde JSON.
   * @param {import('node:http').ServerResponse} res - resposta.
   * @param {number} status - código HTTP.
   * @param {unknown} body - corpo serializável.
   */
  #json(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-PocketHound': String(PROTOCOL_VERSION),
    })
    res.end(text)
  }

  /**
   * Confere o token do cabeçalho Authorization.
   * @param {import('node:http').IncomingMessage} req - requisição.
   * @returns {boolean} se a chamada está autorizada.
   */
  #authorized(req) {
    const header = String(req.headers.authorization ?? '')
    if (!header.startsWith('Bearer ')) return false
    return safeEqual(header.slice(7), this.token)
  }

  /**
   * Roteia uma requisição.
   * @param {import('node:http').IncomingMessage} req - requisição.
   * @param {import('node:http').ServerResponse} res - resposta.
   */
  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.replace(/\/+$/, '') || '/'

    if (route === '/health') {
      this.#json(res, 200, { ok: true, ...this.describe(), hub: this.hub.snapshot() })
      return
    }

    if (!this.#authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="pockethound"' })
      res.end()
      return
    }

    switch (route) {
      case '/sessions':
        // A lista pode consultar o disco (sessões frias), então é assíncrona.
        this.#json(res, 200, { sessions: await this.listSessions(), cursor: this.hub.seq })
        return

      case '/pending':
        this.#json(res, 200, { approvals: this.hub.listPending(), cursor: this.hub.seq })
        return

      case '/stream':
        this.#stream(req, res, url)
        return

      case '/prompt': {
        const body = await readJson(req)
        const result = await this.onPrompt(body)
        this.#json(res, result.ok ? 200 : 400, result)
        return
      }

      case '/approval': {
        const body = await readJson(req)
        const result = this.hub.decideApproval(body)
        this.#json(res, result.ok ? 200 : 404, result)
        return
      }

      case '/question': {
        const body = await readJson(req)
        const result = this.hub.answerQuestion(body)
        this.#json(res, result.ok ? 200 : 404, result)
        return
      }

      case '/presence': {
        const body = await readJson(req)
        this.hub.setPhoneCount(body.phones)
        this.#json(res, 200, { ok: true, phones: this.hub.phoneCount })
        return
      }

      case '/cancel': {
        const body = await readJson(req)
        const ok = this.onCancel(String(body.sessionId ?? ''), String(body.cause ?? 'pockethound:phone'))
        this.#json(res, ok ? 200 : 404, { ok })
        return
      }

      default:
        this.#json(res, 404, { error: { code: 'NOT_FOUND', message: route } })
    }
  }

  /**
   * Abre o fluxo SSE e faz o replay pedido pelo cursor.
   * @param {import('node:http').IncomingMessage} req - requisição.
   * @param {import('node:http').ServerResponse} res - resposta.
   * @param {URL} url - URL com o parâmetro \`cursor\`.
   */
  #stream(req, res, url) {
    const cursor = Number(url.searchParams.get('cursor') ?? '0')
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': pockethound ' + PROTOCOL_VERSION + '\n\n')

    // Heartbeat: mantém a conexão viva através de proxies ociosos e deixa o
    // app perceber a queda rápido em vez de esperar o timeout do TCP.
    const beat = setInterval(() => {
      try {
        res.write(': beat\n\n')
      } catch {
        clearInterval(beat)
      }
    }, 15000)
    if (typeof beat.unref === 'function') beat.unref()

    const subscription = this.hub.subscribe(cursor, (frame) => {
      res.write('id: ' + frame.seq + '\ndata: ' + JSON.stringify(frame) + '\n\n')
    })

    const close = () => {
      clearInterval(beat)
      subscription.close()
      try {
        res.end()
      } catch { /* conexão já encerrada */ }
    }
    req.on('close', close)
    req.on('error', close)
  }
}

export { OUTBOUND }
