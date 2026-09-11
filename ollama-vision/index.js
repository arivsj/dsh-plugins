/**
 * ollama-vision — visão local para modelos que não enxergam imagens.
 *
 * Registra duas tools:
 *   - vision_ask    — pergunta sobre uma ou mais imagens; um modelo de visão local responde em texto.
 *   - vision_warmup — informa a prontidão e/ou inicia o carregamento do modelo agora.
 *
 * O plugin é "cold-start aware": carregar um modelo grande pode levar minutos.
 * Por isso ele (1) pré-carrega o modelo quando o harness sobe, (2) mantém o
 * modelo residente com um keep_alive longo, (3) reporta o tempo de load em todo
 * resultado e (4) permite começar o load cedo via vision_warmup enquanto o
 * agente continua fazendo outra coisa.
 *
 * @module dsh-ollama-vision
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const name = 'ollama-vision'
const inject = ['tools', 'systemPrompt']

const Config = z.object({
  baseUrl: z.string().default('http://127.0.0.1:11434'),
  model: z.string().default('gemma4:e2b'),
  keepAlive: z.string().default('30m'),
  warmupOnStart: z.boolean().default(true),
  warmupDelayMs: z.number().default(2500),
  warmupWaitMs: z.number().default(600000),
  requestTimeoutMs: z.number().default(900000),
  toolTimeoutMs: z.number().default(900000),
  maxTokens: z.number().default(768),
  temperature: z.number().default(0.2),
  numCtx: z.number().default(0),
  think: z.boolean().default(false),
  includeThinking: z.boolean().default(false),
  maxImages: z.number().default(4),
  maxImageBytes: z.number().default(20 * 1024 * 1024),
  maxAnswerChars: z.number().default(8000),
  autoAttachments: z.boolean().default(true),
  attachmentMaxAgeMs: z.number().default(900000),
  dshHome: z.string().default(''),
  debug: z.boolean().default(false),
})

/* ------------------------------------------------------------------ utilidades */

function makeLog(cfg) {
  return (...parts) => {
    if (cfg.debug) console.error('[ollama-vision]', ...parts)
  }
}

function asKeepAlive(value) {
  const text = String(value ?? '').trim()
  if (/^-?\d+$/.test(text)) return Number(text)
  return text === '' ? '30m' : text
}

function trimAnswer(text, max) {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max) + '\n… (resposta truncada)', truncated: true }
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return value.toFixed(unit === 0 ? 0 : 1) + ' ' + units[unit]
}

function humanSeconds(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  return (ms / 1000).toFixed(1) + 's'
}

function modelMatches(runningName, wanted) {
  if (!runningName || !wanted) return false
  if (runningName === wanted) return true
  const short = (value) => String(value).split(':')[0]
  return short(runningName) === short(wanted)
}

/* ------------------------------------------------------------------- imagens */

const MAGIC = [
  { mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.length > 6 && b.subarray(0, 3).toString('latin1') === 'GIF' },
  {
    mime: 'image/webp',
    test: (b) =>
      b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { mime: 'image/bmp', test: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
  { mime: 'image/tiff', test: (b) => b.length > 4 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) },
  { mime: 'image/avif', test: (b) => b.length > 12 && b.subarray(4, 12).toString('latin1').includes('ftypavif') },
]

function sniffMime(buffer) {
  for (const entry of MAGIC) {
    try {
      if (entry.test(buffer)) return entry.mime
    } catch {
      /* teste que estourou o buffer: segue para o próximo */
    }
  }
  return null
}

function dshHome(cfg) {
  if (cfg.dshHome) return cfg.dshHome
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

function attachmentRoot(cfg) {
  return join(dshHome(cfg), 'attachments', 'v1', 'objects')
}

async function findAttachmentByHash(cfg, hash) {
  const root = attachmentRoot(cfg)
  const wanted = String(hash).toLowerCase()
  let prefixes = []
  try {
    prefixes = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue
    const dir = join(root, prefix.name)
    let files = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (file.toLowerCase() === wanted) return join(dir, file)
    }
  }
  return null
}

/** Anexos recentes do DSH (imagens coladas no chat), do mais novo para o mais antigo. */
async function findRecentAttachments(cfg) {
  const root = attachmentRoot(cfg)
  const cutoff = Date.now() - cfg.attachmentMaxAgeMs
  const candidates = []
  let prefixes = []
  try {
    prefixes = await readdir(root, { withFileTypes: true })
  } catch {
    return candidates
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue
    const dir = join(root, prefix.name)
    let files = []
    try {
      files = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile()) continue
      const full = join(dir, file.name)
      try {
        const info = await stat(full)
        if (info.mtimeMs < cutoff || info.size === 0) continue
        candidates.push({ path: full, mtimeMs: info.mtimeMs, size: info.size })
      } catch {
        /* arquivo removido no meio do caminho */
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const images = []
  for (const candidate of candidates) {
    if (images.length >= cfg.maxImages) break
    try {
      const buffer = await readFile(candidate.path)
      if (sniffMime(buffer.subarray(0, 32))) images.push(candidate)
    } catch {
      /* ilegível */
    }
  }
  return images
}

function decodeDataUri(ref) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(ref)
  if (!match) return null
  const mime = match[1] || 'application/octet-stream'
  const payload = match[3] || ''
  const buffer = match[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  return { buffer, mime }
}

function finishImage(cfg, buffer, mime, source) {
  if (buffer.length === 0) throw new Error('imagem vazia: ' + source)
  if (buffer.length > cfg.maxImageBytes) {
    throw new Error(
      'imagem grande demais para ' + source + ' (' + humanBytes(buffer.length) + ' > ' + humanBytes(cfg.maxImageBytes) + ')',
    )
  }
  return { source, mime, bytes: buffer.length, base64: buffer.toString('base64') }
}

/** Resolve uma referência (caminho, URL, data-uri, sha256:) em bytes de imagem. */
async function loadImageReference(cfg, ref, signal, log) {
  const raw = String(ref ?? '').trim()
  if (raw === '') throw new Error('referência de imagem vazia')

  if (/^data:/i.test(raw)) {
    const decoded = decodeDataUri(raw)
    if (!decoded) throw new Error('data-uri de imagem inválido')
    return finishImage(cfg, decoded.buffer, decoded.mime, 'data-uri')
  }

  if (/^https?:\/\//i.test(raw)) {
    const response = await fetch(raw, { signal })
    if (!response.ok) throw new Error('falha ao baixar ' + raw + ': HTTP ' + response.status)
    const buffer = Buffer.from(await response.arrayBuffer())
    const mime = sniffMime(buffer) || response.headers.get('content-type') || 'application/octet-stream'
    return finishImage(cfg, buffer, mime, raw)
  }

  let path = raw
  const hashMatch = /^(?:sha256|attachment):([0-9a-f]{16,})$/i.exec(raw)
  if (hashMatch) {
    const found = await findAttachmentByHash(cfg, hashMatch[1])
    if (!found) throw new Error('anexo ' + raw + ' não encontrado em ' + attachmentRoot(cfg))
    path = found
  } else if (/^file:\/\//i.test(raw)) {
    path = fileURLToPath(raw)
  } else if (!isAbsolute(path)) {
    path = resolve(process.cwd(), path)
  }

  let info = null
  try {
    info = await stat(path)
  } catch (error) {
    throw new Error('não consegui ler "' + raw + '" (' + (error?.code || error?.message) + ')')
  }
  if (info.isDirectory()) throw new Error('"' + raw + '" é um diretório; passe o caminho de um arquivo de imagem')

  const buffer = await readFile(path, { signal })
  const mime = sniffMime(buffer)
  if (!mime) {
    log('arquivo sem assinatura de imagem reconhecida:', path)
    throw new Error('"' + raw + '" não parece ser uma imagem suportada (PNG, JPEG, GIF, WEBP, BMP, TIFF, AVIF)')
  }
  return finishImage(cfg, buffer, mime, path)
}

async function collectImages(cfg, refs, signal, log) {
  const list = Array.isArray(refs) ? refs.filter((item) => String(item ?? '').trim() !== '') : []
  if (list.length > cfg.maxImages) {
    throw new Error('muitas imagens: ' + list.length + ' (máximo configurado: ' + cfg.maxImages + ')')
  }
  const images = []
  for (const ref of list) images.push(await loadImageReference(cfg, ref, signal, log))
  if (images.length > 0) return { images, auto: false }

  if (!cfg.autoAttachments) throw new Error('nenhuma imagem informada e a busca automática por anexos está desligada')

  const recent = await findRecentAttachments(cfg)
  if (recent.length === 0) {
    throw new Error(
      'nenhuma imagem informada e nenhum anexo recente do DSH encontrado em ' +
        attachmentRoot(cfg) +
        ' — passe o caminho do arquivo em "images"',
    )
  }
  for (const candidate of recent) {
    const buffer = await readFile(candidate.path, { signal })
    images.push(finishImage(cfg, buffer, sniffMime(buffer.subarray(0, 32)), 'anexo:' + candidate.path))
  }
  return { images, auto: true }
}

/* -------------------------------------------------------------------- ollama */

async function ollamaJson(cfg, path, options = {}) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + path
  const response = await fetch(url, {
    method: options.method || 'GET',
    signal: options.signal,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error('Ollama respondeu HTTP ' + response.status + ' em ' + path + (text ? ': ' + text.slice(0, 300) : ''))
  }
  return response.json()
}

async function serverVersion(cfg, signal) {
  try {
    const data = await ollamaJson(cfg, '/api/version', { signal })
    return typeof data?.version === 'string' ? data.version : ''
  } catch {
    return ''
  }
}

async function runningModels(cfg, signal) {
  const data = await ollamaJson(cfg, '/api/ps', { signal })
  return Array.isArray(data?.models) ? data.models : []
}

/** Um pedido curto que só serve para trazer o modelo para a memória. */
async function warmupRequest(cfg, model, signal) {
  const startedAt = Date.now()
  const data = await ollamaJson(cfg, '/api/generate', {
    method: 'POST',
    signal,
    body: {
      model,
      prompt: 'ok',
      stream: false,
      keep_alive: asKeepAlive(cfg.keepAlive),
      options: { num_predict: 1, temperature: 0 },
    },
  })
  return { totalMs: Date.now() - startedAt, loadMs: Math.round((data?.load_duration ?? 0) / 1e6) }
}

/** Conversa com imagens; consome NDJSON em streaming para acompanhar o progresso. */
async function visionChat(cfg, model, prompt, images, signal, log) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/api/chat'
  const options = { temperature: cfg.temperature }
  if (cfg.maxTokens > 0) options.num_predict = cfg.maxTokens
  if (cfg.numCtx > 0) options.num_ctx = cfg.numCtx

  const body = {
    model,
    stream: true,
    keep_alive: asKeepAlive(cfg.keepAlive),
    options,
    messages: [{ role: 'user', content: prompt, images: images.map((image) => image.base64) }],
  }
  if (cfg.think === false) body.think = false

  const startedAt = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error('Ollama respondeu HTTP ' + response.status + ' em /api/chat' + (text ? ': ' + text.slice(0, 400) : ''))
  }

  let content = ''
  let thinking = ''
  let firstChunkMs = 0
  let metrics = {}

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
      if (line === '') continue
      let chunk = null
      try {
        chunk = JSON.parse(line)
      } catch {
        continue
      }
      if (chunk.error) throw new Error('Ollama: ' + String(chunk.error).slice(0, 400))
      const piece = chunk?.message?.content
      if (typeof piece === 'string' && piece !== '') {
        if (firstChunkMs === 0) firstChunkMs = Date.now() - startedAt
        content += piece
      }
      const reasoning = chunk?.message?.thinking
      if (typeof reasoning === 'string' && reasoning !== '') thinking += reasoning
      if (chunk.done) metrics = chunk
    }
  }

  const totalMs = Date.now() - startedAt
  const loadMs = Math.round((metrics?.load_duration ?? 0) / 1e6)
  if (loadMs > 5000) log('modelo', model, 'carregado em', humanSeconds(loadMs))
  return {
    content,
    thinking,
    totalMs,
    firstChunkMs: firstChunkMs || totalMs,
    loadMs,
    promptTokens: metrics?.prompt_eval_count ?? 0,
    outputTokens: metrics?.eval_count ?? 0,
    evalMs: Math.round((metrics?.eval_duration ?? 0) / 1e6),
    doneReason: metrics?.done_reason ?? '',
  }
}

/* --------------------------------------------------------------------- estado */

const state = {
  warmup: null,
  lastLoadMs: 0,
  lastModel: '',
}

function beginWarmup(cfg, model, log) {
  const current = state.warmup
  if (current && current.model === model && current.status === 'loading') return current

  const entry = { model, status: 'loading', startedAt: Date.now(), error: '', result: null }
  entry.promise = (async () => {
    try {
      const result = await warmupRequest(cfg, model, null)
      entry.status = 'loaded'
      entry.result = result
      state.lastLoadMs = result.loadMs
      state.lastModel = model
      log('warmup concluído para', model, 'load', humanSeconds(result.loadMs))
    } catch (error) {
      entry.status = 'failed'
      entry.error = String(error?.message || error)
      log('warmup falhou para', model, entry.error)
    }
    return entry
  })()
  state.warmup = entry
  return entry
}

function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      rejectPromise(new Error('cancelado'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolvePromise()
    }, ms)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Espera o modelo ficar residente consultando /api/ps. */
async function waitForResident(cfg, model, timeoutMs, signal, log) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('cancelado')
    const models = await runningModels(cfg, signal)
    if (models.some((entry) => modelMatches(entry?.name || entry?.model, model))) return true
    await sleep(1500, signal)
  }
  log('timeout esperando', model, 'ficar residente')
  return false
}

/* ---------------------------------------------------------------------- tools */

function statusText(status) {
  if (status === 'loaded') return 'modelo carregado e residente'
  if (status === 'loading') return 'modelo carregando'
  if (status === 'load-failed') return 'falha ao carregar o modelo'
  if (status === 'unloaded') return 'modelo não residente'
  return 'servidor Ollama inacessível'
}

function visionAnswerText(value) {
  const notes = []
  if (value.cold_start) notes.push('cold start: load ' + humanSeconds(value.load_ms))
  notes.push('total ' + humanSeconds(value.total_ms))
  notes.push(value.model)
  if (value.images.length > 1) notes.push(value.images.length + ' imagens')
  if (value.truncated) notes.push('resposta truncada')
  return [
    value.answer,
    '',
    '[vision_ask · ' + notes.join(' · ') + ']',
    'imagens: ' + value.images.map((image) => image.source).join(', '),
  ].join('\n')
}

function registerVisionAsk(ctx, cfg, log) {
  ctx.tools.register(
    defineTool({
      name: 'vision_ask',
      description:
        'Answer a question about one or more images using a LOCAL vision model (Ollama). Use this whenever a task depends on what an image shows - screenshots, photos, diagrams, charts, UI mockups, scanned documents - including images the user attached to the conversation: this agent cannot see images itself, but the local vision model can, and it returns its answer as text. Pass file paths, http(s) URLs, data URIs or "sha256:<attachment id>" references, or omit images to use the newest image(s) attached to this conversation. Write the prompt in the language the answer should be in, and ask for exactly what you need (transcribe the text, describe the layout, read the axis labels...). The model may need a cold start of a few minutes; call vision_warmup first when you expect to need vision later in the same turn.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'What to ask about the image(s), in the language the answer should use.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Image references: absolute/relative file paths, http(s) URLs, data URIs, or "sha256:<id>" attachment references. Omit to use the newest image(s) attached to this conversation.',
        },
        model: { type: 'string', description: 'Optional Ollama vision model override (defaults to the configured model).' },
        wait: {
          type: 'boolean',
          description:
            'Whether to wait for a cold model load (minutes). Default true. Set false to fail fast when the model is not resident yet; a background load is started either way.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Optional cap in milliseconds for this call (defaults to the plugin config).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answer: { type: 'string', required: true },
            model: { type: 'string', required: true },
            images: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: { type: 'string', required: true },
                  mime: { type: 'string', required: true },
                  bytes: { type: 'integer', required: true },
                },
              },
            },
            auto_images: { type: 'boolean', required: true },
            cold_start: { type: 'boolean', required: true },
            load_ms: { type: 'integer', required: true },
            total_ms: { type: 'integer', required: true },
            first_token_ms: { type: 'integer', required: true },
            prompt_tokens: { type: 'integer', required: true },
            output_tokens: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
            thinking: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: visionAnswerText(value) }],
        presentationMeta: (_args, value) => ({
          model: value.model,
          images: value.images.length,
          coldStart: value.cold_start,
          totalMs: value.total_ms,
        }),
      },
      timeoutMs: cfg.toolTimeoutMs,
      presentCall: (args) => ({
        card: 'generic',
        kind: 'read',
        title: 'vision_ask: ' + String(args.prompt || '').slice(0, 90),
        rawInput:
          Array.isArray(args.images) && args.images.length > 0 ? { images: args.images } : 'anexos recentes da conversa',
        content: [
          {
            type: 'text',
            text:
              'Modelo de visão local (' +
              (args.model || cfg.model) +
              ') - se estiver frio, o carregamento leva alguns minutos.',
          },
        ],
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        kind: 'read',
        title: result.isError ? 'vision_ask falhou' : 'vision_ask concluído',
        content: result.content,
      }),
      async execute(args, exec) {
        const model = args.model || cfg.model
        const wait = args.wait !== false
        const timeoutMs =
          Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : cfg.requestTimeoutMs

        const controller = new AbortController()
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
        const onAbort = () => controller.abort()
        exec.signal?.addEventListener('abort', onAbort, { once: true })
        const signal = controller.signal

        try {
          const collected = await collectImages(cfg, args.images, signal, log)

          let resident = []
          try {
            resident = await runningModels(cfg, signal)
          } catch (error) {
            throw new Error(
              'não consegui falar com o Ollama em ' +
                cfg.baseUrl +
                ': ' +
                (error?.message || error) +
                ' - verifique se o servidor está no ar (comando: ollama serve).',
            )
          }
          const cold = !resident.some((entry) => modelMatches(entry?.name || entry?.model, model))
          if (cold) beginWarmup(cfg, model, log)

          if (cold && !wait) {
            throw new Error(
              'o modelo "' +
                model +
                '" não está residente: o carregamento leva alguns minutos e já foi iniciado em background. ' +
                'Chame vision_warmup (wait: true) ou repita vision_ask em seguida.',
            )
          }

          const result = await visionChat(cfg, model, args.prompt, collected.images, signal, log)
          const answer = trimAnswer(result.content.trim(), cfg.maxAnswerChars)
          state.lastLoadMs = result.loadMs
          state.lastModel = model

          const value = {
            answer:
              answer.text === ''
                ? '(o modelo de visão não retornou texto' +
                  (result.doneReason ? '; done_reason=' + result.doneReason : '') +
                  ')'
                : answer.text,
            model,
            images: collected.images.map((image) => ({ source: image.source, mime: image.mime, bytes: image.bytes })),
            auto_images: collected.auto,
            cold_start: cold || result.loadMs > 5000,
            load_ms: result.loadMs,
            total_ms: result.totalMs,
            first_token_ms: result.firstChunkMs,
            prompt_tokens: result.promptTokens,
            output_tokens: result.outputTokens,
            truncated: answer.truncated,
          }
          if (cfg.includeThinking && result.thinking.trim() !== '') value.thinking = result.thinking.trim()
          log('vision_ask ok', model, humanSeconds(result.totalMs), collected.images.length, 'imagem(ns)')
          return value
        } catch (error) {
          if (timedOut) {
            throw new Error(
              'vision_ask excedeu ' +
                humanSeconds(timeoutMs) +
                ' (o modelo "' +
                model +
                '" ainda pode estar carregando). Tente de novo ou aumente requestTimeoutMs.',
            )
          }
          if (exec.signal?.aborted) throw new Error('vision_ask cancelado pelo chamador')
          throw error
        } finally {
          clearTimeout(timer)
          exec.signal?.removeEventListener('abort', onAbort)
        }
      },
    }),
  )
}

function residentNames(models) {
  return models
    .map((entry) => String(entry?.name || entry?.model || ''))
    .filter((item) => item !== '')
}

function registerVisionWarmup(ctx, cfg, log) {
  ctx.tools.register(
    defineTool({
      name: 'vision_warmup',
      description:
        'Check and prepare the local vision model (Ollama) used by vision_ask. Reports whether the model is resident, the Ollama version, which models are loaded, and how many recent conversation images are available; with warmup: true it also starts loading the model now, so a later vision_ask does not pay the (minutes-long) cold start. Call it at the start of a turn that will need vision and keep working while it loads. Use unload: true to free memory when a long vision session is over.',
      parameters: {
        model: { type: 'string', description: 'Optional Ollama vision model override (defaults to the configured model).' },
        warmup: { type: 'boolean', description: 'Start loading the model now if it is not resident. Default true.' },
        wait: {
          type: 'boolean',
          description: 'Block until the model is resident (bounded by timeout_ms). Default true when warmup is on.',
        },
        unload: { type: 'boolean', description: 'Unload the model (keep_alive 0) to free memory. Default false.' },
        timeout_ms: {
          type: 'integer',
          description: 'Optional cap in milliseconds for the wait (defaults to the plugin config).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            model: { type: 'string', required: true },
            status: {
              type: 'string',
              required: true,
              enum: ['loaded', 'loading', 'load-failed', 'unloaded', 'unreachable'],
            },
            changed: { type: 'boolean', required: true },
            waited_ms: { type: 'integer', required: true },
            load_ms: { type: 'integer', required: true },
            server_version: { type: 'string', required: true },
            resident: { type: 'array', required: true, items: { type: 'string' } },
            recent_attachments: { type: 'integer', required: true },
            detail: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              'vision_warmup · ' + value.model + ' · ' + value.status + ' - ' + statusText(value.status),
              'ollama: ' +
                (value.server_version || '?') +
                ' · residentes: ' +
                (value.resident.length > 0 ? value.resident.join(', ') : 'nenhum'),
              'anexos recentes disponíveis: ' + value.recent_attachments,
              value.load_ms > 0 ? 'último load: ' + humanSeconds(value.load_ms) : '',
              value.detail,
            ]
              .filter((line) => line !== '')
              .join('\n'),
          },
        ],
      },
      timeoutMs: cfg.toolTimeoutMs,
      presentCall: (args) => ({
        card: 'generic',
        kind: 'execute',
        title:
          args.unload === true
            ? 'vision_warmup: descarregar ' + (args.model || cfg.model)
            : 'vision_warmup: preparar ' + (args.model || cfg.model),
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        kind: 'execute',
        title: result.isError ? 'vision_warmup falhou' : 'vision_warmup concluído',
        content: result.content,
      }),
      async execute(args, exec) {
        const model = args.model || cfg.model
        const startedAt = Date.now()
        const timeoutMs = Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : cfg.warmupWaitMs

        const result = {
          model,
          status: 'unreachable',
          changed: false,
          waited_ms: 0,
          load_ms: 0,
          server_version: '',
          resident: [],
          recent_attachments: 0,
          detail: '',
        }

        const version = await serverVersion(cfg, exec.signal)
        if (version === '') {
          result.waited_ms = Date.now() - startedAt
          result.detail = 'Ollama inacessível em ' + cfg.baseUrl + ' - rode o servidor ou ajuste baseUrl.'
          return result
        }
        result.server_version = version
        result.recent_attachments = (await findRecentAttachments(cfg).catch(() => [])).length

        let running = []
        try {
          running = await runningModels(cfg, exec.signal)
        } catch (error) {
          result.waited_ms = Date.now() - startedAt
          result.detail = 'falha ao consultar /api/ps: ' + (error?.message || error)
          return result
        }
        result.resident = residentNames(running)

        if (args.unload === true) {
          result.status = 'unloaded'
          result.changed = true
          result.waited_ms = Date.now() - startedAt
          result.detail = 'keep_alive enviado como 0.'
          try {
            await ollamaJson(cfg, '/api/generate', {
              method: 'POST',
              signal: exec.signal,
              body: { model, prompt: '', keep_alive: 0, options: { num_predict: 1 } },
            })
          } catch (error) {
            result.status = 'load-failed'
            result.detail = 'falha ao descarregar: ' + (error?.message || error)
          }
          return result
        }

        const already = running.some((entry) => modelMatches(entry?.name || entry?.model, model))
        if (already) {
          result.status = 'loaded'
          result.load_ms = state.lastModel === model ? state.lastLoadMs : 0
          result.waited_ms = Date.now() - startedAt
          result.detail = 'já estava residente; nenhum carregamento necessário.'
          return result
        }

        if (args.warmup === false) {
          result.status = 'unloaded'
          result.waited_ms = Date.now() - startedAt
          result.detail = 'não está residente e warmup: false - nada foi carregado.'
          return result
        }

        const entry = beginWarmup(cfg, model, log)
        result.changed = true

        if (args.wait === false) {
          result.status = 'loading'
          result.waited_ms = Date.now() - startedAt
          result.detail = 'carregamento iniciado em background; use vision_warmup com wait: true para aguardar.'
          return result
        }

        const loaded = await waitForResident(cfg, model, timeoutMs, exec.signal, log)
        result.waited_ms = Date.now() - startedAt
        if (entry.result) result.load_ms = entry.result.loadMs
        if (loaded) {
          result.status = 'loaded'
          result.load_ms = result.load_ms || entry.result?.loadMs || result.waited_ms
          result.resident = residentNames(await runningModels(cfg, exec.signal).catch(() => running))
          result.detail = 'pronto para vision_ask.'
        } else if (entry.status === 'failed') {
          result.status = 'load-failed'
          result.detail = entry.error
        } else {
          result.status = 'loading'
          result.detail =
            'ainda carregando depois de ' + humanSeconds(timeoutMs) + '; siga com outra tarefa e tente vision_ask depois.'
        }
        return result
      },
    }),
  )
}

/* ---------------------------------------------------------------------- apply */

function apply(ctx, config) {
  const cfg = config
  const log = makeLog(cfg)

  ctx.systemPrompt.section({
    name: 'tool:vision_ask',
    order: 115,
    text:
      'You cannot see images. When a task depends on what an image shows (a screenshot, photo, diagram, chart or scanned page, including images the user attached to this conversation), call vision_ask: a local vision model reads the image and returns text. That model can take a few minutes to load on a cold start, so when you expect to need vision later in the same turn, call vision_warmup first and continue with other work while it loads; results report how long the load took.',
  })

  registerVisionAsk(ctx, cfg, log)
  registerVisionWarmup(ctx, cfg, log)

  if (cfg.warmupOnStart) {
    const timer = setTimeout(() => {
      beginWarmup(cfg, cfg.model, log)
    }, Math.max(0, cfg.warmupDelayMs))
    timer.unref?.()
  }

  log('plugin carregado; modelo padrão', cfg.model, 'em', cfg.baseUrl)
}

export { Config, apply, inject, name }
