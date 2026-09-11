/**
 * Self-test da metade cliente (lib/client.js) sem navegador: carrega o bundle
 * num contexto vm com window/document/navigator falsos, registra o componente
 * num slot falso e simula um clique completo (gravacao -> POST -> setDraft),
 * alem dos caminhos de erro.
 *
 *   node .dev/client-self-test.mjs
 */
import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')
const source = await readFile(bundlePath, 'utf8')

let failures = 0
function check(label, condition, detail) {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FALHA') + ' | ' + label + (detail === undefined ? '' : ' -> ' + detail))
}

/* ------------------------------------------------------------- react de mentira */

const hooks = []
let cursor = 0
function resetCursor() {
  cursor = 0
}
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  },
  useRef(initial) {
    const index = cursor++
    if (hooks[index] === undefined) hooks[index] = { current: initial }
    return hooks[index]
  },
  useState(initial) {
    const index = cursor++
    if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
    }
    return [hooks[index], set]
  },
  useEffect(fn, deps) {
    const index = cursor++
    const previous = hooks[index]
    const first = previous === undefined
    const changed = first || deps === undefined || deps.some((dep, at) => dep !== previous.deps[at])
    if (!changed) return
    if (!first && typeof previous.cleanup === 'function') previous.cleanup()
    const cleanup = fn()
    hooks[index] = { deps, cleanup }
  },
}

/* ----------------------------------------------------------- navegador de mentira */

const listeners = new Map()
let lastFetch = null
let fetchReply = { ok: true, status: 200, body: { ok: true, text: 'bom dia, tudo bem?' } }

class FakeMediaRecorder {
  constructor(stream, options) {
    this.stream = stream
    this.mimeType = (options && options.mimeType) || 'audio/webm'
    this.state = 'inactive'
  }
  static isTypeSupported(type) {
    return type.indexOf('webm') !== -1
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    if (this.ondataavailable) this.ondataavailable({ data: new Blob(['audio-falso'], { type: 'audio/webm' }) })
    if (this.onstop) this.onstop()
  }
}

const styleNodes = []
const documentStub = {
  head: {
    appendChild(node) {
      styleNodes.push(node)
    },
  },
  getElementById(id) {
    return styleNodes.find((node) => node.id === id) || null
  },
  createElement(tag) {
    return {
      tagName: tag,
      id: '',
      textContent: '',
      parentNode: null,
      remove() {
        this.parentNode = null
      },
    }
  },
}

const windowStub = {
  MediaRecorder: FakeMediaRecorder,
  fetch: async (url, options) => {
    lastFetch = { url, options }
    return {
      ok: fetchReply.ok,
      status: fetchReply.status,
      json: async () => fetchReply.body,
    }
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  addEventListener: (name, handler) => listeners.set(name, handler),
  removeEventListener: (name) => listeners.delete(name),
}

const context = createContext({
  window: windowStub,
  document: documentStub,
  navigator: {
    mediaDevices: {
      async getUserMedia() {
        return { getTracks: () => [{ stop() {} }] }
      },
    },
  },
  console,
  Blob,
  Uint8Array,
  JSON,
  Symbol,
  Object,
  Promise,
  Error,
  String,
  Math,
  Number,
  RegExp,
  Array,
  Date,
})
windowStub.window = windowStub

let loaded = null
windowStub.__ModuleLoader__ = {
  load(record) {
    loaded = record
  },
}

runInContext(source, context, { filename: bundlePath })

check('bundle registra factory com o id correto', loaded && loaded.id === 'dsh-voice-input', loaded && loaded.id)

const exportsObject = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error('modulo inesperado no bundle: ' + id)
})
check('exports.apply e uma funcao', typeof exportsObject.apply === 'function')
check('inject inclui slots', Array.isArray(exportsObject.inject) && exportsObject.inject.indexOf('slots') !== -1, JSON.stringify(exportsObject.inject))
check('MicButton exportado', typeof exportsObject.MicButton === 'function')

/* ------------------------------------------------------------------- apply falso */

let registration = null
let injections = []
const ctx = {
  effect(fn) {
    const disposer = fn()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  slots: {
    inject(key, callback) {
      injections.push(key)
      callback()
      return () => {}
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
}
exportsObject.apply(ctx)

check('slot alvo correto', injections[0] === 'conversation.input.left', JSON.stringify(injections))
check('registro no slot com id', registration && registration.options.id === 'voice-input', JSON.stringify(registration && registration.options))
check('componente registrado', registration && registration.component === exportsObject.MicButton)
check('estilos injetados uma vez', styleNodes.length === 1, styleNodes.length + ' style(s)')

/* ------------------------------------------------------------------ fluxo completo */

const drafts = []
const props = {
  input: { draft: 'texto anterior' },
  inputActions: {
    setDraft(text) {
      drafts.push(text)
    },
  },
  useInput: () => ({ draft: 'texto anterior' }),
  sessionId: 'self-test',
}

resetCursor()
let tree = registration.component(props)
check('render inicial e um botao', tree && tree.type === 'button', tree && tree.type)
check('estado inicial idle', tree && tree.props['data-dsh-voice-input'] === 'idle', tree && tree.props['data-dsh-voice-input'])

await tree.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
resetCursor()
tree = registration.component(props)
check('estado apos clique = recording', tree.props['data-dsh-voice-input'] === 'recording', tree.props['data-dsh-voice-input'])
check('botao mostra barras do medidor', tree.children.length === 4, tree.children.length + ' filhos')
check('Esc registrado durante a gravacao', listeners.has('keydown'))

// segundo clique: para a gravacao -> onstop -> POST -> setDraft
const clickAgain = tree.props.onClick
resetCursor()
registration.component(props)
clickAgain()
for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))

check('POST para a rota de transcricao', lastFetch && lastFetch.url === '/voice-input/transcribe', lastFetch && lastFetch.url)
check(
  'content-type do blob enviado',
  lastFetch && String(lastFetch.options.headers['content-type']).indexOf('audio/webm') === 0,
  lastFetch && lastFetch.options.headers['content-type'],
)
check('rascunho recebeu o texto apos espaco', drafts[0] === 'texto anterior bom dia, tudo bem?', JSON.stringify(drafts))
resetCursor()
tree = registration.component(props)
check('volta para idle', tree.props['data-dsh-voice-input'] === 'idle', tree.props['data-dsh-voice-input'])

// rascunho vazio: sem espaco inicial
drafts.length = 0
const propsVazio = { ...props, input: { draft: '' } }
resetCursor()
tree = registration.component(propsVazio)
await tree.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
resetCursor()
tree = registration.component(propsVazio)
tree.props.onClick()
for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
check('rascunho vazio nao ganha espaco', drafts[0] === 'bom dia, tudo bem?', JSON.stringify(drafts))

// erro do backend: estado volta a idle e a nota aparece no title
fetchReply = { ok: false, status: 500, body: { ok: false, error: 'worker dormindo' } }
resetCursor()
tree = registration.component(props)
await tree.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
resetCursor()
tree = registration.component(props)
tree.props.onClick()
for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
resetCursor()
tree = registration.component(props)
check('erro volta para idle', tree.props['data-dsh-voice-input'] === 'idle', tree.props['data-dsh-voice-input'])
check('erro aparece no title', String(tree.props.title).indexOf('worker dormindo') !== -1, tree.props.title)
check('classe de erro aplicada', String(tree.props.className).indexOf('dsvi-err') !== -1, tree.props.className)

// texto vazio do backend
fetchReply = { ok: true, status: 200, body: { ok: true, text: '   ' } }
drafts.length = 0
resetCursor()
tree = registration.component(props)
await tree.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
resetCursor()
tree = registration.component(props)
tree.props.onClick()
for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
resetCursor()
tree = registration.component(props)
check('texto vazio nao escreve no rascunho', drafts.length === 0, JSON.stringify(drafts))
check('nota "nada reconhecido"', String(tree.props.title).indexOf('nada reconhecido') !== -1, tree.props.title)

console.log('')
console.log(failures === 0 ? 'TODOS OS TESTES PASSARAM' : failures + ' teste(s) falharam')
process.exit(failures === 0 ? 0 : 1)
