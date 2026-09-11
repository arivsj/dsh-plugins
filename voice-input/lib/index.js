/**
 * voice-input — metade host: rota HTTP que transcreve audio com Whisper local.
 *
 * Registra duas rotas exatas no webserver do DSH:
 *   - POST /voice-input/transcribe  — corpo = audio cru (webm/ogg/wav/mp4);
 *     resposta = { ok, text, language, duration, ms, model, worker }.
 *   - GET  /voice-input/status      — diagnostico (worker vivo? modelo pronto?
 *     tempo de load, caminho do python, do vendor e do modelo).
 *
 * O motor e o worker Python (faster-whisper) em whisper_server.py: o plugin o
 * mantem residente entre requisicoes (carregar o modelo custa segundos a
 * minutos) e o desliga junto com o harness. O audio recebido e convertido por
 * ffmpeg para WAV 16 kHz mono antes de entrar no modelo.
 *
 * A metade cliente (lib/client.js) e o botao de microfone no composer.
 *
 * @module dsh-voice-input
 */
import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'voice-input'
// Sem dependencia obrigatoria: assim o plugin ATIVA em qualquer perfil (web,
// headless, futuros). As rotas entram no bloco ctx.inject abaixo, que so roda
// onde existir um webserver — declarar 'webServer' aqui deixaria a entry pendente
// em perfis sem HTTP e o boot do harness falha nesse caso.
const inject = []

const HERE = dirname(fileURLToPath(import.meta.url))

const Config = z.object({
  route: z.string().default('/voice-input/transcribe'),
  statusRoute: z.string().default('/voice-input/status'),
  language: z.string().default('pt'),
  model: z.string().default('small'),
  device: z.string().default('cpu'),
  computeType: z.string().default('int8'),
  beamSize: z.number().default(5),
  initialPrompt: z.string().default('Transcrição de fala em português do Brasil, com pontuação e acentuação corretas.'),
  python: z.string().default('python3'),
  worker: z.string().default(''),
  vendor: z.string().default(''),
  modelDir: z.string().default(''),
  ffmpeg: z.string().default('ffmpeg'),
  maxBytes: z.number().default(64 * 1024 * 1024),
  readyTimeoutMs: z.number().default(1800000),
  requestTimeoutMs: z.number().default(900000),
  warmupOnStart: z.boolean().default(true),
  warmupDelayMs: z.number().default(2000),
  debug: z.boolean().default(false),
})

/* ------------------------------------------------------------------ utilidades */

function makeLog(cfg) {
  return (...parts) => {
    if (cfg.debug) console.error('[voice-input]', ...parts)
  }
}

function resolveWorker(cfg) {
  const candidates = []
  if (cfg.worker) candidates.push(cfg.worker)
  candidates.push(join(HERE, '..', 'whisper_server.py'))
  candidates.push(join(HERE, 'whisper_server.py'))
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

function extensionFor(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave') return '.wav'
  if (type === 'audio/ogg' || type === 'audio/opus') return '.ogg'
  if (type === 'audio/mp4' || type === 'audio/m4a' || type === 'audio/aac') return '.m4a'
  if (type === 'audio/mpeg' || type === 'audio/mp3') return '.mp3'
  if (type === 'audio/webm' || type === 'video/webm') return '.webm'
  return '.webm'
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('audio acima do limite de ' + maxBytes + ' bytes'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function runFfmpeg(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('ffmpeg excedeu ' + timeoutMs + 'ms'))
    }, timeoutMs)
    timer.unref?.()
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error('ffmpeg indisponivel: ' + error.message))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('ffmpeg falhou (codigo ' + code + '): ' + stderr.trim().slice(-300)))
    })
  })
}

/* -------------------------------------------------------------------- worker */

function createEngine(cfg, log) {
  let child = null
  let lines = null
  let stderrTail = ''
  let sequence = 0
  const pending = new Map()
  let ready = null
  let fatal = ''
  let loadingSince = 0
  let requests = 0
  let lastError = ''
  let queue = Promise.resolve()
  const waiters = new Set()

  function notifyWaiters(error) {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
      if (error) waiter.reject(error)
      else waiter.resolve(ready)
    }
  }

  function state() {
    if (!child) return 'down'
    if (ready) return 'ready'
    return 'loading'
  }

  function settleAll(error) {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  function fail(error) {
    lastError = error.message
    notifyWaiters(error)
  }

  function handleLine(line) {
    const text = line.trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      log('worker stdout nao-JSON:', text.slice(0, 300))
      return
    }
    if (message.t === 'ready') {
      ready = message
      fatal = ''
      log('modelo carregado em', message.loadMs + 'ms', 'modelo', message.model)
      notifyWaiters(null)
      return
    }
    if (message.t === 'fatal') {
      fatal = String(message.error || 'erro no worker')
      lastError = fatal
      log('worker fatal:', fatal)
      settleAll(new Error(fatal))
      notifyWaiters(new Error(fatal))
      return
    }
    if (message.t === 'result') {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message)
      else entry.reject(new Error(String(message.error || 'falha na transcricao')))
      return
    }
    log('worker:', text.slice(0, 300))
  }

  function start() {
    if (child) return
    const script = resolveWorker(cfg)
    if (!script) throw new Error('whisper_server.py nao encontrado; configure worker= no plugin')
    const args = [
      script,
      '--model', cfg.model,
      '--language', cfg.language,
      '--device', cfg.device,
      '--compute-type', cfg.computeType,
      '--beam-size', String(cfg.beamSize),
    ]
    if (cfg.modelDir) args.push('--model-dir', cfg.modelDir)
    if (cfg.initialPrompt) args.push('--initial-prompt', cfg.initialPrompt)
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    if (cfg.vendor) env.PYTHONPATH = env.PYTHONPATH ? cfg.vendor + ':' + env.PYTHONPATH : cfg.vendor
    ready = null
    fatal = ''
    loadingSince = Date.now()
    log('iniciando worker:', cfg.python, script)
    child = spawn(cfg.python, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    lines = createInterface({ input: child.stdout })
    lines.on('line', handleLine)
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000)
      log('worker stderr:', String(chunk).trim().slice(0, 300))
    })
    child.on('error', (error) => {
      const failure = new Error('nao foi possivel executar ' + cfg.python + ': ' + error.message)
      fatal = failure.message
      log(failure.message)
      child = null
      ready = null
      settleAll(failure)
      fail(failure)
    })
    child.on('exit', (code, signal) => {
      log('worker saiu', code, signal, stderrTail.trim().slice(-200))
      const wasReady = ready !== null
      child = null
      lines = null
      ready = null
      const detail = stderrTail.trim().slice(-200) || 'codigo ' + code
      if (pending.size > 0) settleAll(new Error('worker encerrou durante a transcricao: ' + detail))
      if (!wasReady) fail(new Error(fatal || ('worker encerrou antes de carregar o modelo: ' + detail)))
    })
  }

  function stop() {
    notifyWaiters(new Error('worker encerrado'))
    if (!child) return
    const dying = child
    child = null
    ready = null
    settleAll(new Error('worker encerrado'))
    try {
      dying.stdin?.write(JSON.stringify({ cmd: 'shutdown' }) + '\n')
    } catch {
      /* stdin ja fechado */
    }
    const killer = setTimeout(() => dying.kill('SIGKILL'), 1500)
    killer.unref?.()
    dying.on('exit', () => clearTimeout(killer))
  }

  function waitReady(timeoutMs) {
    if (ready) return Promise.resolve(ready)
    if (!child) {
      fatal = ''
      try {
        start()
      } catch (error) {
        fatal = error.message
        return Promise.reject(error)
      }
    }
    if (ready) return Promise.resolve(ready)
    if (fatal) return Promise.reject(new Error(fatal))
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter)
        reject(new Error('modelo ainda carregando apos ' + timeoutMs + 'ms (' + state() + ')'))
      }, timeoutMs)
      waiters.add(waiter)
    })
  }

  function send(audioPath) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('transcricao excedeu ' + cfg.requestTimeoutMs + 'ms'))
      }, cfg.requestTimeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(JSON.stringify({ id, audio: audioPath }) + '\n')
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  async function transcribe(audioPath) {
    requests += 1
    await waitReady(cfg.readyTimeoutMs)
    const run = queue.then(() => send(audioPath))
    queue = run.then(() => undefined, () => undefined)
    try {
      return await run
    } catch (error) {
      lastError = error.message
      throw error
    }
  }

  return {
    state,
    transcribe,
    warmup: () => waitReady(cfg.readyTimeoutMs),
    stop,
    status: () => ({
      state: state(),
      model: cfg.model,
      language: cfg.language,
      device: cfg.device,
      computeType: cfg.computeType,
      ready: ready !== null,
      loadMs: ready?.loadMs ?? 0,
      loadingMs: child && !ready ? Date.now() - loadingSince : 0,
      requests,
      lastError,
      python: cfg.python,
      worker: resolveWorker(cfg),
      vendor: cfg.vendor,
      modelDir: cfg.modelDir,
      ffmpeg: cfg.ffmpeg,
      stderr: stderrTail.trim().slice(-500),
    }),
  }
}

/* -------------------------------------------------------------------- apply */

function apply(ctx, config) {
  const cfg = config
  const log = makeLog(cfg)
  const engine = createEngine(cfg, log)

  async function handleTranscribe(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST com o audio no corpo' })
      return
    }
    let dir = ''
    try {
      const body = await readBody(req, cfg.maxBytes)
      if (body.length === 0) throw new Error('corpo vazio: nenhum audio recebido')
      dir = await mkdtemp(join(tmpdir(), 'dsh-voice-'))
      const source = join(dir, 'origem' + extensionFor(req.headers['content-type']))
      const wav = join(dir, 'convertido.wav')
      await writeFile(source, body)
      await runFfmpeg(
        cfg.ffmpeg,
        ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
        120000,
      )
      const result = await engine.transcribe(wav)
      log('transcrito em', result.ms + 'ms', String(result.text || '').slice(0, 120))
      sendJson(res, 200, {
        ok: true,
        text: result.text || '',
        language: result.language || cfg.language,
        duration: result.duration || 0,
        ms: result.ms || 0,
        model: cfg.model,
        bytes: body.length,
      })
    } catch (error) {
      const message = String((error && error.message) || error)
      log('falha:', message)
      sendJson(res, 500, { ok: false, error: message })
    } finally {
      if (dir) rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function handleStatus(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'use GET' })
      return
    }
    const status = engine.status()
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    sendJson(res, 200, { ok: true, ...status })
  }

  if (ctx.get('webServer') === undefined) {
    log('este perfil nao tem webserver: nada a registrar aqui (o plugin fica inativo)')
  }

  // Dependencia OPCIONAL: o callback roda quando (e se) existir um webserver. Rota,
  // worker e warmup vivem aqui dentro, entao um perfil sem HTTP nao gasta nada.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({ kind: 'exact', path: cfg.route, handler: handleTranscribe }),
      'voice-input: rota de transcricao',
    )
    scope.effect(
      () => scope.webServer.register({ kind: 'exact', path: cfg.statusRoute, handler: handleStatus }),
      'voice-input: rota de diagnostico',
    )
    scope.effect(() => () => engine.stop(), 'voice-input: worker de transcricao')

    if (cfg.modelDir) {
      mkdir(cfg.modelDir, { recursive: true }).catch((error) => log('nao criou modelDir:', error.message))
    }

    if (cfg.warmupOnStart) {
      const timer = setTimeout(() => {
        engine.warmup().catch((error) => log('warmup falhou:', error.message))
      }, Math.max(0, cfg.warmupDelayMs))
      timer.unref?.()
    }

    log('rotas prontas', cfg.route, '| modelo', cfg.model, '| idioma', cfg.language)
  })
}

export { Config, apply, inject, name }
