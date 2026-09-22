import { spawn } from 'node:child_process'
const PORT = 9339
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn('google-chrome', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--disable-extensions','--remote-debugging-port=' + PORT,'--user-data-dir=/tmp/dsh-click-probe','about:blank'], { stdio: ['ignore','ignore','pipe'] })
chrome.stderr.on('data', () => {})
async function cdp(path, options) { return (await fetch('http://127.0.0.1:' + PORT + path, options)).json() }
for (let i = 0; i < 80; i += 1) { try { await cdp('/json/version'); break } catch { await sleep(400) } }
const alvo = await cdp('/json/new?about:blank', { method: 'PUT' })
const socket = new WebSocket(alvo.webSocketDebuggerUrl)
const pend = new Map(); let seq = 0
function send(m, p = {}) { const id = ++seq; return new Promise((res) => { pend.set(id, res); socket.send(JSON.stringify({ id, method: m, params: p })) }) }
socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value
await new Promise((r) => socket.addEventListener('open', r))
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: 'http://127.0.0.1:3080/' })
await sleep(18000)
const titulo = process.env.PROBE_TITULO || 'Botão de atualização para o chat'
await evalJs(`(() => { const b = [...document.querySelectorAll('button,[role="button"]')].find((el) => /open sidebar/i.test(el.getAttribute('aria-label')||'')); if (b) b.click(); return true; })()`)
await sleep(2500)
console.log('clicar em: ' + titulo)
console.log(await evalJs(`(() => {
  const alvos = [...document.querySelectorAll('button,[role="button"],a,li,div,span')]
    .filter((el) => (el.textContent||'').indexOf(${JSON.stringify(titulo)}) !== -1)
  const menor = alvos.sort((a, b) => (a.textContent||'').length - (b.textContent||'').length)[0]
  if (!menor) return 'nao achei'
  menor.click()
  return 'clicado: ' + (menor.textContent||'').trim().slice(0,60)
})()`))
await sleep(12000)
console.log(JSON.stringify(await evalJs(`(() => { const l = document.querySelector('[data-dsh-session-cost]'); return { temLinha: Boolean(l), texto: l ? l.textContent : null, dica: l ? l.getAttribute('title') : null, fim: document.body.innerText.replace(/\\s+/g,' ').slice(-200) }; })()`), null, 1))
socket.close(); chrome.kill('SIGKILL'); process.exit(0)
