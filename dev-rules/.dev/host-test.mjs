/**
 * Autoteste do dsh-dev-rules (metade host) — sem harness, com um ctx de mentira.
 *
 *   node .dev/host-test.mjs
 *
 * Prova o que o plugin promete: a secao entra no prompt com as regras ligadas, a
 * escolha do dev (namespace de settings) manda no catalogo, regra nova nasce
 * ligada, desligar tudo devolve o prompt original, e a rota mostra exatamente o
 * texto que esta indo para o prompt.
 */

import { apply, Config, NS, textoDoPrompt, comEscolhas, REGRAS_DE_FABRICA } from '../lib/index.js'

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

/**
 * Um ctx de mentira que guarda o que o plugin registrou.
 * @param escolhas - o que o namespace de settings devolve em `get()`.
 * @returns o ctx, as secoes, as rotas e o escopo.
 */
function ctxFalso(escolhas = {}) {
  const secoes = []
  const rotas = []
  let escopo = null
  return {
    secoes,
    rotas,
    escopoDe: () => escopo,
    ctx: {
      inject(servicos, cb) {
        const alvo = { effect: (fn) => { fn(); return () => {} } }
        if (servicos.includes('settings')) {
          alvo.settings = {
            register: (ns, schema) => {
              escopo = { ns, schema, get: () => escolhas }
              return escopo
            },
          }
        }
        if (servicos.includes('systemPrompt')) {
          alvo.systemPrompt = {
            section: (secao) => {
              secoes.push(secao)
              return () => {}
            },
          }
        }
        if (servicos.includes('webServer')) {
          alvo.webServer = {
            register: (rota) => {
              rotas.push(rota)
              return () => {}
            },
          }
        }
        cb(alvo)
      },
    },
  }
}

/**
 * Chama um handler de rota e devolve o corpo da resposta.
 * @param handler - handler registrado.
 * @returns o texto respondido.
 */
async function corpoDaRota(handler) {
  return new Promise((resolve) => {
    handler({ method: 'GET', headers: {} }, {
      writeHead() {},
      end(corpo) { resolve(String(corpo)) },
    })
  })
}

console.log('catalogo de fabrica')
check('traz as tres regras que o dev pediu', REGRAS_DE_FABRICA.length === 3, REGRAS_DE_FABRICA.map((r) => r.id))
check('e todas nascem ligadas', REGRAS_DE_FABRICA.every((r) => r.ligada === true))

console.log('a secao no prompt inicial')
const simples = ctxFalso()
apply(simples.ctx, Config({}))
check('registrou uma secao so', simples.secoes.length === 1, simples.secoes.map((s) => s.name))
check('com nome proprio', simples.secoes[0]?.name === 'dev:regras', simples.secoes[0]?.name)
check('e ordem depois da persona', simples.secoes[0]?.order === 10, simples.secoes[0]?.order)
const textoBase = simples.secoes[0]?.text?.() ?? ''
check('o texto e uma FUNCAO (reavaliado a cada passo)', typeof simples.secoes[0]?.text === 'function')
check('traz as tres regras numeradas', (textoBase.match(/^\d\. /gm) ?? []).length === 3, textoBase)
check('a primeira e a do .md privado', textoBase.includes('GitHub'), textoBase.slice(0, 160))
check('o cabecalho diz que elas vencem o resto', textoBase.includes('vencem'), textoBase.slice(0, 200))
check('e o namespace e o do id da entry', simples.escopoDe()?.ns === NS, simples.escopoDe()?.ns)

console.log('a escolha do dev manda no catalogo')
const comUmaFora = ctxFalso({ ligadas: [], desligadas: ['responder-antes-de-codar'] })
apply(comUmaFora.ctx, Config({}))
const textoComUmaFora = comUmaFora.secoes[0].text()
check('a regra desligada sai do texto', !textoComUmaFora.includes('responda antes'), textoComUmaFora)
check('e sobram duas', (textoComUmaFora.match(/^\d\. /gm) ?? []).length === 2, textoComUmaFora)

const tudoFora = ctxFalso({ ligadas: [], desligadas: REGRAS_DE_FABRICA.map((r) => r.id) })
apply(tudoFora.ctx, Config({}))
check('desligar tudo devolve o prompt original', tudoFora.secoes[0].text() === '', tudoFora.secoes[0].text())

const ligadaAMao = ctxFalso({ ligadas: ['extra'], desligadas: [] })
apply(ligadaAMao.ctx, Config({ regras: [{ id: 'extra', texto: 'regra que nasce desligada', ligada: false }] }))
check('o dev liga na mao uma regra que nasce desligada', ligadaAMao.secoes[0].text().includes('regra que nasce desligada'))

console.log('regra nova no catalogo')
const novas = comEscolhas(
  [{ id: 'nova', texto: 'x', ligada: true }, { id: 'velha', texto: 'y', ligada: true }],
  { ligadas: ['velha'], desligadas: ['outra'] },
)
check('nasce LIGADA, e nao desligada por nao estar na escolha salva', novas[0].ligada === true, novas)
check('e a escolha antiga continua valendo para as outras', novas[1].ligada === true, novas)

console.log('cabecalho proprio pela config')
const comCabecalho = ctxFalso()
apply(comCabecalho.ctx, Config({ cabecalho: 'Regras da casa:' }))
check('o cabecalho da config entra no lugar do de fabrica', comCabecalho.secoes[0].text().startsWith('Regras da casa:'))

console.log('desligado nao registra nada')
const desligado = ctxFalso()
apply(desligado.ctx, Config({ enabled: false }))
check('sem secao e sem rota', desligado.secoes.length === 0 && desligado.rotas.length === 0)

console.log('a rota mostra o texto que vai para o prompt')
const comRota = ctxFalso({ ligadas: [], desligadas: ['md-privado'] })
apply(comRota.ctx, Config({}))
check('registrou a rota', comRota.rotas[0]?.path === '/dev-rules/texto', comRota.rotas[0]?.path)
const corpo = JSON.parse(await corpoDaRota(comRota.rotas[0].handler))
check('devolve as regras com o estado resolvido', corpo.regras.find((r) => r.id === 'md-privado')?.ligada === false, corpo.regras)
check('e o texto bate com o da secao', corpo.texto === comRota.secoes[0].text(), corpo.texto.slice(0, 120))
check('e devolve a escolha crua, para a tela', Array.isArray(corpo.escolhas.desligadas), corpo.escolhas)

console.log('regras que o dev escreve na tela')
const comMinhas = ctxFalso({
  ligadas: [],
  desligadas: [],
  minhas: [{ id: 'minha-1', texto: 'sempre me diga o que vai fazer antes', ligada: true }],
})
apply(comMinhas.ctx, Config({}))
const textoComMinhas = comMinhas.secoes[0].text()
check('a regra escrita na tela entra no texto', textoComMinhas.includes('sempre me diga o que vai fazer antes'), textoComMinhas)
check('e entra DEPOIS do catalogo', textoComMinhas.trimEnd().endsWith('sempre me diga o que vai fazer antes'), textoComMinhas.split('\n').slice(-2))
check('o catalogo continua inteiro', (textoComMinhas.match(/^\d\. /gm) ?? []).length === 4, textoComMinhas)

const minhasDesligadas = ctxFalso({
  ligadas: [],
  desligadas: [],
  minhas: [{ id: 'minha-1', texto: 'regra desligada', ligada: false }],
})
apply(minhasDesligadas.ctx, Config({}))
check('regra do dev desligada sai do texto', !minhasDesligadas.secoes[0].text().includes('regra desligada'))

// A escolha do catalogo e' um DELTA por id; a regra do dev carrega o proprio
// `ligada` e nao pode ser atingida por ele — senao desligar uma regra do catalogo
// desligaria uma regra do dev que por acaso tivesse o mesmo id.
const deltaParecido = ctxFalso({
  ligadas: [],
  desligadas: ['minha-1'],
  minhas: [{ id: 'minha-1', texto: 'regra do dev', ligada: true }],
})
apply(deltaParecido.ctx, Config({}))
check('delta do catalogo nao mexe na regra do dev', deltaParecido.secoes[0].text().includes('regra do dev'), deltaParecido.secoes[0].text())

const soMinhas = ctxFalso({
  ligadas: [],
  desligadas: REGRAS_DE_FABRICA.map((regra) => regra.id),
  minhas: [{ id: 'minha-1', texto: 'a unica que vale', ligada: true }],
})
apply(soMinhas.ctx, Config({}))
const textoSoMinhas = soMinhas.secoes[0].text()
check('com o catalogo todo fora, sobra a regra do dev', (textoSoMinhas.match(/^\d\. /gm) ?? []).length === 1 && textoSoMinhas.includes('a unica que vale'), textoSoMinhas)

const rota = ctxFalso({ ligadas: [], desligadas: [], minhas: [{ id: 'minha-9', texto: 'na rota', ligada: true }] })
apply(rota.ctx, Config({}))
const corpoRota = JSON.parse(await corpoDaRota(rota.rotas[0].handler))
check('a rota marca a origem de cada regra', corpoRota.regras.some((r) => r.origem === 'minha' && r.id === 'minha-9'), corpoRota.regras.map((r) => r.id + ':' + r.origem))
check('e a regra do dev aparece no texto da rota', corpoRota.texto.includes('na rota'), corpoRota.texto.slice(-60))
console.log('textoDoPrompt sozinho')
check('sem regra ligada devolve vazio', textoDoPrompt([{ id: 'a', texto: 'x', ligada: false }]) === '')
check('ignora regra de texto vazio', textoDoPrompt([{ id: 'a', texto: '   ', ligada: true }]) === '')

console.log('')
console.log(passed + ' passaram, ' + failed + ' falharam')
process.exit(failed === 0 ? 0 : 1)
