/**
 * Self-test do plugin ollama-vision, sem subir o harness: registra as tools num
 * ctx falso, valida os schemas com ajv e chama o Ollama local de verdade.
 *
 *   node .dev/self-test.mjs [caminho-da-imagem]
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { apply, Config } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const imagePath = process.argv[2] || join(here, 'test-image.png')
const fakeHome = join(here, 'fake-dsh')

let registered = new Map()
let sections = []

const makeCtx = () => ({
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
  },
})

const baseConfig = {
  warmupOnStart: false,
  debug: true,
  keepAlive: '15m',
  requestTimeoutMs: 600000,
  toolTimeoutMs: 600000,
}

const ctx = makeCtx()
const cfg = Config(baseConfig)
console.log('config resolvida:', JSON.stringify({ model: cfg.model, baseUrl: cfg.baseUrl, maxImages: cfg.maxImages }))
apply(ctx, cfg)
console.log('tools registradas:', [...registered.keys()].join(', '))
console.log('system prompt sections:', sections.map((s) => s.name + '@' + s.order).join(', '))

const ajv = new Ajv({ strict: false, allErrors: true })
const validators = new Map()
for (const [toolName, definition] of registered) {
  validators.set(toolName + ':args', ajv.compile(definition.parameters))
  validators.set(toolName + ':out', ajv.compile(definition.output.schema))
}

const makeExec = () => ({
  callId: 'self-test',
  name: 'self-test',
  arguments: {},
  signal: new AbortController().signal,
  deferContext() {},
  concludeTurn() {},
})

let failures = 0
const check = (label, ok, extra) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' -> ' + String(extra)))
  if (!ok) failures += 1
}

async function run(toolName, args) {
  const definition = registered.get(toolName)
  const argsOk = validators.get(toolName + ':args')
  if (!argsOk(args)) {
    check('args schema ' + toolName, false, JSON.stringify(argsOk.errors))
    return null
  }
  const value = await definition.execute(args, makeExec())
  const outOk = validators.get(toolName + ':out')
  check('output schema ' + toolName, outOk(value), JSON.stringify(outOk.errors))
  const rendered = definition.output.render(args, value)
  check('render ' + toolName, Array.isArray(rendered) && rendered[0]?.type === 'text', JSON.stringify(rendered[0]).slice(0, 120))
  if (definition.output.schema) check('output schema compilado ' + toolName, Boolean(definition.output.schema))
  return { value, rendered }
}

const warmupOff = await run('vision_warmup', { warmup: false })
check('vision_warmup alcançou o Ollama', warmupOff && warmupOff.value.status !== 'unreachable', warmupOff?.value.server_version)

const ask = await run('vision_ask', {
  prompt: 'Descreva a imagem em uma frase curta, em português: quais formas e cores aparecem?',
  images: [imagePath],
})
check('vision_ask respondeu', Boolean(ask && ask.value.answer.length > 10), ask ? JSON.stringify(ask.value.answer.slice(0, 160)) : 'sem valor')
if (ask) console.log('--- render vision_ask ---\n' + ask.rendered[0].text + '\n---')

// busca automática de anexos do DSH (imagem colada no chat) usando um DSH_HOME falso
registered = new Map()
sections = []
const autoCtx = makeCtx()
apply(autoCtx, Config({ ...baseConfig, dshHome: fakeHome }))
const auto = await run('vision_ask', { prompt: 'Responda apenas com as cores presentes na imagem, separadas por vírgula.' })
check('auto-descoberta de anexo', Boolean(auto && auto.value.auto_images === true), auto && auto.value.images.map((i) => i.source).join(','))

try {
  await run('vision_ask', { prompt: 'x', images: [join(here, 'nao-existe-mesmo.png')] })
  check('erro em arquivo inexistente', false, 'nenhum erro lançado')
} catch (error) {
  check('erro em arquivo inexistente', /não consegui ler/.test(String(error.message)), String(error.message).slice(0, 110))
}

try {
  await run('vision_ask', { prompt: 'x', images: [join(here, '..', 'package.json')] })
  check('erro em arquivo não-imagem', false, 'nenhum erro lançado')
} catch (error) {
  check('erro em arquivo não-imagem', /não parece ser uma imagem/.test(String(error.message)), String(error.message).slice(0, 110))
}

const dataUri = 'data:image/png;base64,' + (await readFile(imagePath)).toString('base64')
const askData = await run('vision_ask', { prompt: 'Apenas liste as cores, separadas por vírgula.', images: [dataUri] })
check('vision_ask via data-uri', Boolean(askData && askData.value.images[0].source === 'data-uri'))

// cold start: modelo não residente com wait:false deve falhar rápido e explicativo
try {
  await run('vision_ask', { prompt: 'x', images: [imagePath], model: 'modelo-que-nao-existe:1b', wait: false })
  check('wait:false com modelo frio', false, 'nenhum erro lançado')
} catch (error) {
  check('wait:false com modelo frio', /não está residente/.test(String(error.message)), String(error.message).slice(0, 200))
}

// status de um modelo não residente não deve carregar nada
const notResident = await run('vision_warmup', { model: 'modelo-que-nao-existe:1b', warmup: false })
check('vision_warmup warmup:false', notResident?.value.status === 'unloaded', notResident && notResident.value.status)

for (const [toolName, definition] of registered) {
  const view = definition.presentCall({ prompt: 'oi', images: [imagePath] })
  check('presentCall ' + toolName, view?.card === 'generic' && typeof view.title === 'string', view && view.title)
  if (typeof definition.presentResult === 'function') {
    const resultView = definition.presentResult({ prompt: 'oi' }, { content: [{ type: 'text', text: 'x' }], isError: false })
    check('presentResult ' + toolName, resultView?.card === 'generic', resultView && resultView.title)
  }
}

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : '\n' + failures + ' TESTE(S) FALHARAM')
process.exit(failures === 0 ? 0 : 1)
