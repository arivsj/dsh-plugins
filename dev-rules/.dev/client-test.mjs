/**
 * Autoteste do dsh-dev-rules (metade cliente) — sem navegador.
 *
 *   node .dev/client-test.mjs
 *
 * Carrega o bundle num `vm` com um React minimo e um ctx de mentira, e prova o
 * que a tela precisa acertar: o cartao entra no slot certo, com a CHAVE do
 * namespace (sem ela o DSH nao despacha cartao nenhum), e desenha as regras que o
 * host devolve.
 */

import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

let passed = 0
let failed = 0

/**
 * Registra o resultado de uma verificacao.
 * @param label - o que foi verificado.
 * @param condition - se passou.
 * @param detail - contexto em caso de falha.
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + label)
  } else {
    failed += 1
    console.log('  FALHA ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''))
  }
}

/** React minimo: o suficiente para o cartao rodar fora do navegador. */
const React = {
  createElement(tipo, props, ...filhos) {
    return { tipo, props: props ?? {}, filhos: filhos.flat() }
  },
  useState(inicial) { return [typeof inicial === 'function' ? inicial() : inicial, () => {}] },
  useEffect(efeito) { efeito() },
  useCallback(fn) { return fn },
}

/** Acha o primeiro no da arvore cujo texto contenha o pedaco. */
function contemTexto(no, pedaco) {
  if (no === null || no === undefined) return false
  if (typeof no === 'string') return no.includes(pedaco)
  if (Array.isArray(no)) return no.some((filho) => contemTexto(filho, pedaco))
  if (typeof no === 'object' && no.filhos) return contemTexto(no.filhos, pedaco)
  return false
}

const registros = []
let escopoLigado = null
const fonte = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const caixa = {
  window: { __ModuleLoader__: { load: (modulo) => { caixa.modulo = modulo } } },
  document: { createElement: () => ({ style: {}, appendChild() {}, }) , head: { appendChild() {} } },
  fetch: async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        regras: [
          { id: 'md-privado', texto: 'regra do md', ligada: true },
          { id: 'responder-antes-de-codar', texto: 'regra da pergunta', ligada: false },
        ],
        texto: 'Regras do dev:\n\n1. regra do md',
        escolhas: { ligadas: [], desligadas: [] },
      }
    },
  }),
  console,
}
caixa.window.window = caixa.window
createContext(caixa)
runInContext(fonte, caixa)

const modulo = caixa.modulo
check('o bundle se registra com o id do pacote', modulo?.id === 'dsh-dev-rules', modulo?.id)

const exports = modulo.factory((nome) => {
  if (nome === 'react') return React
  throw new Error('require inesperado: ' + nome)
})

check('declara os servicos que usa', Array.isArray(exports.inject) && exports.inject.includes('settingsScope') && exports.inject.includes('slots'), exports.inject)

const ctx = {
  settingsScope: {
    bind(spec) {
      escopoLigado = spec
      return {
        getSnapshot: () => ({ status: 'ready', writable: true, value: { ligadas: [], desligadas: [] } }),
        subscribe: () => () => {},
        set: async () => {},
      }
    },
  },
  slots: {
    inject(nome, cb) { cb() },
    register(opcoes, componente) { registros.push({ opcoes, componente }) },
  },
}
exports.apply(ctx)

check('ligou o escopo no namespace certo', escopoLigado?.namespace === 'dev-rules', escopoLigado)
check('registrou UM cartao', registros.length === 1, registros.length)
check('no slot dos plugins configuraveis', registros[0]?.opcoes?.name === 'settings.plugin.item', registros[0]?.opcoes?.name)
check('com a CHAVE do namespace (sem ela a aba nao despacha)', registros[0]?.opcoes?.key === 'dev-rules', registros[0]?.opcoes?.key)

const props = { ...(registros[0].opcoes.inject?.() ?? {}) }
check('o cartao recebe o escopo', Boolean(props.escopo))

const arvore = registros[0].componente(props)
check('nomeia o plugin no cartao', contemTexto(arvore, 'Regras do dev'))
check('desenha o cabecalho da secao', contemTexto(arvore, 'prompt inicial'), JSON.stringify(arvore).slice(0, 120))
check('desenha o texto do prompt para conferencia', contemTexto(arvore, 'O texto que esta indo para o prompt'))

console.log('o campo de regra nova')
const vazio = exports.montarMinhas([], '   ')
check('texto vazio nao vira regra', vazio.length === 0, vazio)
const uma = exports.montarMinhas([], '  nao me interrompa  ')
check('a regra nova entra com o texto aparado', uma.length === 1 && uma[0].texto === 'nao me interrompa', uma)
check('e nasce ligada', uma[0].ligada === true, uma)
const duas = exports.montarMinhas(uma, 'segunda regra')
check('acrescentar nao perde as antigas', duas.length === 2 && duas[0].texto === 'nao me interrompa', duas)
check('e cada uma tem id proprio', duas[0].id !== duas[1].id, duas.map((r) => r.id))
console.log('')
console.log(passed + ' passaram, ' + failed + ' falharam')
process.exit(failed === 0 ? 0 : 1)
