/**
 * Prova que a projecao `sessionCost` CHEGA ao navegador.
 *
 * A pagina nova do harness abre numa sessao vazia (sem uso), entao a linha de
 * custo nao desenha nada — nao por defeito, por falta de dado. O que da para
 * provar aqui e o caminho do dado: o servidor manda a projecao para o cliente, e
 * ela vem com o valor que o host calculou. Se a metade host nao tivesse
 * registrado a projecao, a chave nao existiria nas mensagens.
 *
 *   node .dev/projection-probe.mjs
 */
import { spawn } from 'node:child_process'
const PORT = Number(process.env.CDP_PORT || 9336)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn('google-chrome', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--disable-extensions','--remote-debugging-port=' + PORT,'--user-data-dir=/tmp/dsh-projection-probe','about:blank'], { stdio: ['ignore','ignore','pipe'] })
chrome.stderr.on('data', () => {})
async function cdp(path, options) { return (await fetch('http://127.0.0.1:' + PORT + path, options)).json() }
for (let i = 0; i < 80; i += 1) { try { await cdp('/json/version'); break } catch { await sleep(400) } }
const alvo = await cdp('/json/new?about:blank', { method: 'PUT' })
const socket = new WebSocket(alvo.webSocketDebuggerUrl)
const pend = new Map(); let seq = 0
function send(method, params = {}) { const id = ++seq; return new Promise((res) => { pend.set(id, res); socket.send(JSON.stringify({ id, method, params })) }) }
socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
await new Promise((r) => socket.addEventListener('open', r))
await send('Runtime.enable'); await send('Page.enable')

// Espia o socket ANTES de a pagina rodar: tudo o que o servidor manda fica guardado.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__probeMsgs = [];
    const Original = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new Original(...args);
      ws.addEventListener('message', (evento) => {
        try { window.__probeMsgs.push(String(evento.data).slice(0, 4000)); } catch {}
      });
      return ws;
    };
    window.WebSocket.prototype = Original.prototype;
    Object.assign(window.WebSocket, Original);
  })()`,
})

await send('Page.navigate', { url: 'http://127.0.0.1:3080/' })
await sleep(20000)

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const msgs = window.__probeMsgs || [];
    const comCusto = msgs.filter((m) => m.indexOf('sessionCost') !== -1);
    const amostra = comCusto.length ? comCusto[comCusto.length - 1] : null;
    const i = amostra ? amostra.indexOf('sessionCost') : -1;
    return {
      mensagens: msgs.length,
      comSessionCost: comCusto.length,
      trecho: amostra ? amostra.slice(Math.max(0, i - 40), i + 260) : null,
      temTokenUsage: msgs.some((m) => m.indexOf('tokenUsage') !== -1),
      linhaNoDom: Boolean(document.querySelector('[data-dsh-session-cost]')),
    };
  })()`,
  returnByValue: true,
})
console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2))
socket.close(); chrome.kill('SIGKILL'); process.exit(0)
