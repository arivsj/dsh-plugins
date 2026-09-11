/**
 * Teste ponta a ponta no navegador real (Chrome headless via CDP): substitui
 * MediaRecorder/getUserMedia por um gravador falso que devolve um WAV de
 * verdade, clica no botao do microfone, deixa o fetch chegar ao servidor DSH
 * rodando, e confere se o texto transcrito apareceu na textarea do composer.
 *
 *   node .dev/browser-e2e.mjs [audio.wav] [url]
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const audioPath = resolve(process.argv[2] || join(root, '..', '..', 'drive_files', 'leituras', 'leia_8948290413328226890.wav'))
const TARGET = process.argv[3] || 'http://127.0.0.1:3080'
const PORT = Number(process.env.CDP_PORT || 9334)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const audioBase64 = (await readFile(audioPath)).toString('base64')
console.log('audio:', audioPath, '(' + Math.round(audioBase64.length / 1024) + ' KB em base64)')

const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-extensions',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=/tmp/dsh-browser-e2e',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
chrome.stderr.on('data', () => {})

async function cdpJson(path, options) {
  const response = await fetch('http://127.0.0.1:' + PORT + path, options)
  return response.json()
}

let ready = false
for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
  try {
    await cdpJson('/json/version')
    ready = true
  } catch {
    await sleep(400)
  }
}
if (!ready) {
  console.log(JSON.stringify({ fatal: 'devtools nao respondeu' }))
  chrome.kill('SIGKILL')
  process.exit(1)
}

const target = await cdpJson('/json/new?' + encodeURIComponent(TARGET), { method: 'PUT' })
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const events = []
let sequence = 0

function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve) => {
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    events.push({ kind: 'console.' + message.params.type, text: (message.params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ').slice(0, 240) })
  } else if (message.method === 'Runtime.exceptionThrown') {
    events.push({ kind: 'exception', text: String(message.params.exceptionDetails.text || '') + ' ' + String(message.params.exceptionDetails.exception?.description || '').slice(0, 240) })
  }
})

await new Promise((resolve) => socket.addEventListener('open', resolve))
await send('Runtime.enable')
await sleep(15000)

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.result?.exceptionDetails) {
    return { error: String(response.result.exceptionDetails.text || '') + ' ' + String(response.result.exceptionDetails.exception?.description || '').slice(0, 300) }
  }
  return response.result?.result?.value
}

const setup = await evaluate(`(() => {
  const bytes = Uint8Array.from(atob('${audioBase64}'), (char) => char.charCodeAt(0));
  window.__probeChunks = [];
  window.MediaRecorder = class FakeRecorder {
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = (options && options.mimeType) || 'audio/wav';
      this.state = 'inactive';
    }
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      if (this.ondataavailable) this.ondataavailable({ data: new Blob([bytes], { type: 'audio/wav' }) });
      if (this.onstop) this.onstop();
    }
  };
  navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
  const button = document.querySelector('button[data-dsh-voice-input]');
  return { hasButton: Boolean(button), patched: typeof window.MediaRecorder === 'function' };
})()`)
console.log('setup:', JSON.stringify(setup))

const click = async (label) => {
  const state = await evaluate(`(() => {
    const button = document.querySelector('button[data-dsh-voice-input]');
    if (!button) return { error: 'botao sumiu' };
    const before = button.getAttribute('data-dsh-voice-input');
    button.click();
    return { before, after: button.getAttribute('data-dsh-voice-input') };
  })()`)
  console.log(label + ':', JSON.stringify(state))
  return state
}

await click('1o clique (gravar)')
await sleep(1500)
await click('2o clique (parar+transcrever)')

let textarea = ''
let state = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(1000)
  const snapshot = await evaluate(`(() => {
    const button = document.querySelector('button[data-dsh-voice-input]');
    const field = document.querySelector('textarea');
    return { state: button ? button.getAttribute('data-dsh-voice-input') : null, title: button ? button.getAttribute('title') : null, value: field ? field.value : null };
  })()`)
  state = snapshot
  textarea = String(snapshot?.value || '')
  if (textarea.trim() !== '' && snapshot.state === 'idle') break
  if (snapshot.state === 'idle' && attempt > 4 && snapshot.title && /falha|nada reconhecido|indisponivel|negada/.test(String(snapshot.title))) break
}

console.log('estado final do botao:', JSON.stringify(state))
console.log('texto na textarea:', JSON.stringify(textarea))
console.log('eventos de console:', JSON.stringify(events, null, 2))

socket.close()
chrome.kill('SIGKILL')
process.exit(textarea.trim() === '' ? 1 : 0)
