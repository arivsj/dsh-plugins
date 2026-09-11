/**
 * Self-test do plugin voice-input, sem subir o harness: monta um ctx falso,
 * registra as rotas, envia um arquivo de audio real pela rota de transcricao e
 * imprime o JSON que o navegador receberia.
 *
 *   node .dev/self-test.mjs [caminho-do-audio] [modelo]
 */
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, Config } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const audioPath = resolve(process.argv[2] || join(root, '..', '..', 'drive_files', 'leituras', 'leia_2000584697112014088.wav'))
const model = process.argv[3] || process.env.MODEL || 'small'

const routes = new Map()
const ctx = {
  effect(fn) {
    const disposer = fn()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}

const cfg = Config({
  worker: join(root, 'whisper_server.py'),
  vendor: join(root, 'vendor'),
  modelDir: join(root, 'models'),
  model,
  language: 'pt',
  debug: true,
  warmupOnStart: false,
  requestTimeoutMs: 900000,
  readyTimeoutMs: 1800000,
})

apply(ctx, cfg)
console.log('rotas registradas:', [...routes.keys()].join(', '))

function fakeRequest(method, body, contentType) {
  const stream = Readable.from(body ? [body] : [])
  stream.method = method
  stream.headers = { 'content-type': contentType || 'application/octet-stream' }
  return stream
}

function fakeResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    },
    text() {
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

async function callRoute(path, method, body, contentType) {
  const route = routes.get(path)
  if (!route) throw new Error('rota ausente: ' + path)
  const res = fakeResponse()
  const started = Date.now()
  await route.handler(fakeRequest(method, body, contentType), res)
  return { status: res.statusCode, ms: Date.now() - started, body: res.text() }
}

const audio = await readFile(audioPath)
console.log('audio:', audioPath, audio.length + ' bytes', '(' + (audio.length / 1024).toFixed(1) + ' KB)')

const started = Date.now()
const result = await callRoute('/voice-input/transcribe', 'POST', audio, 'audio/wav')
console.log('--- POST /voice-input/transcribe ---')
console.log('status:', result.status, '| duracao da chamada:', result.ms + 'ms', '| total:', Date.now() - started + 'ms')
console.log(result.body)

const status = await callRoute('/voice-input/status', 'GET')
console.log('--- GET /voice-input/status ---')
console.log(status.body)
