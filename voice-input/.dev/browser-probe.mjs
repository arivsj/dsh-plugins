/**
 * Verificacao real no navegador (Chrome headless via CDP): abre a pagina do
 * harness, espera o boot, procura o botao do microfone no DOM e recolhe os
 * erros de console do bundle do plugin.
 *
 *   node .dev/browser-probe.mjs [url] [ms-de-espera]
 */
import { spawn } from 'node:child_process'

const PORT = Number(process.env.CDP_PORT || 9333)
const TARGET = process.argv[2] || 'http://127.0.0.1:3080'
const WAIT_MS = Number(process.argv[3] || 15000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    '--user-data-dir=/tmp/dsh-browser-probe',
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
    events.push({
      kind: 'console.' + message.params.type,
      text: (message.params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ').slice(0, 300),
    })
  } else if (message.method === 'Runtime.exceptionThrown') {
    events.push({ kind: 'exception', text: String(message.params.exceptionDetails.text || '') + ' ' + String(message.params.exceptionDetails.exception?.description || '').slice(0, 300) })
  } else if (message.method === 'Log.entryAdded') {
    events.push({ kind: 'log.' + message.params.entry.level, text: String(message.params.entry.text || '').slice(0, 300) })
  }
})

await new Promise((resolve) => socket.addEventListener('open', resolve))
await send('Runtime.enable')
await send('Log.enable')
await sleep(WAIT_MS)

const expression = `(() => {
  const button = document.querySelector('button[data-dsh-voice-input]');
  const boot = (window.__DSH_BOOT__ || { entries: [] }).entries.map((entry) => entry.id);
  return {
    url: location.href,
    title: document.title,
    hasButton: Boolean(button),
    state: button ? button.getAttribute('data-dsh-voice-input') : null,
    buttonTitle: button ? button.getAttribute('title') : null,
    buttonHtml: button ? button.innerHTML.replace(/\\s+/g, ' ').slice(0, 200) : null,
    styleInjected: Boolean(document.getElementById('dsh-voice-input-styles')),
    hasVoiceEntry: boot.indexOf('dsh-voice-input') !== -1,
    bootCount: boot.length,
    textareas: document.querySelectorAll('textarea').length,
    buttons: document.querySelectorAll('button').length,
    bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400),
  };
})()`

const probeResult = await send('Runtime.evaluate', { expression, returnByValue: true })

console.log(JSON.stringify({ probe: probeResult.result?.result?.value ?? probeResult.result, events }, null, 2))
socket.close()
chrome.kill('SIGKILL')
process.exit(0)
