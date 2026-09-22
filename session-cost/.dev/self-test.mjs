/**
 * Provas do session-cost — rodam na JVM do Node, sem harness e sem navegador.
 *
 *   node .dev/self-test.mjs
 *
 * O que se prova aqui e a parte que pode mentir em silencio: a conta em dolar
 * (que depende do horario da amostra) e a regra de substituicao, que impede um
 * passo de ser contado duas vezes.
 */
import { ehPico, medir, minutosDe, definicao, Config } from '../lib/index.js'

let passaram = 0
let falharam = 0

/**
 * Registra o resultado de uma verificacao.
 * @param rotulo - o que foi verificado.
 * @param condicao - se passou.
 * @param detalhe - contexto em caso de falha.
 */
function check(rotulo, condicao, detalhe) {
  if (condicao) {
    passaram += 1
    console.log('  ok   ' + rotulo)
  } else {
    falharam += 1
    console.log('  FALHA ' + rotulo + ' :: ' + JSON.stringify(detalhe))
  }
}

const config = new Config({})
const faixas = [[60, 240], [360, 600]]

console.log('leitura dos horarios')
check('01:00 vira 60 minutos', minutosDe('01:00') === 60)
check('10:00 vira 600', minutosDe('10:00') === 600)
check('texto invalido devolve null', minutosDe('25:00') === null)

console.log('pico x fora de pico (UTC, dias uteis)')
// 2026-09-14 e uma segunda-feira.
check('segunda 02:00 UTC e pico', ehPico(Date.UTC(2026, 8, 14, 2, 0), faixas, [1, 2, 3, 4, 5]) === true)
check('segunda 05:00 UTC e fora do pico', ehPico(Date.UTC(2026, 8, 14, 5, 0), faixas, [1, 2, 3, 4, 5]) === false)
check('sabado 02:00 UTC e fora do pico', ehPico(Date.UTC(2026, 8, 19, 2, 0), faixas, [1, 2, 3, 4, 5]) === false)
check('domingo 08:00 UTC e fora do pico', ehPico(Date.UTC(2026, 8, 20, 8, 0), faixas, [1, 2, 3, 4, 5]) === false)

console.log('a conta em dolar')
// 1M de entrada sem cache + 1M do cache + 1M de saida, em pico:
// 0.30 + 0.006 + 1.20 = 1.506
const emPico = medir(
  { inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 },
  Date.UTC(2026, 8, 14, 2, 0),
  config,
  faixas,
)
check('pico cobra preco cheio', Math.abs(emPico.usd - 1.506) < 1e-9, emPico)

const foraPico = medir(
  { inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 },
  Date.UTC(2026, 8, 14, 5, 0),
  config,
  faixas,
)
check('fora do pico custa metade', Math.abs(foraPico.usd - 0.753) < 1e-9, foraPico)

const escrita = medir(
  { inputTokens: 0, cacheWriteTokens: 1e6, outputTokens: 0 },
  Date.UTC(2026, 8, 14, 2, 0),
  config,
  faixas,
)
check('escrita de cache entra pela tarifa sem cache', Math.abs(escrita.usd - 0.3) < 1e-9, escrita)

console.log('a projecao: dobra o log sem contar duas vezes')
{
  const unidade = definicao(config)
  let estado = unidade.init()
  const amostra = (turn, step, uso, hora) => ({
    type: 'assistant/message',
    time: Date.UTC(2026, 8, 14, hora, 0),
    data: { turn, step, usage: uso },
  })

  // Passo 1 em pico, passo 2 fora do pico: cada um no preco do seu horario.
  estado = unidade.apply(estado, amostra(1, 1, { inputTokens: 1e6, outputTokens: 1e6 }, 2))
  estado = unidade.apply(estado, amostra(1, 2, { inputTokens: 0, outputTokens: 1e6 }, 5))
  const vista = unidade.view(estado)
  check('soma os dois passos', Math.abs(vista.usd - (1.2 + 0.3 + 0.6)) < 1e-9, vista)
  check('guarda quanto saiu no pico', Math.abs(vista.usdPico - 1.5) < 1e-9, vista)
  check('conta duas amostras', vista.amostras === 2, vista)

  // O mesmo passo reportando de novo (chunk de uso e depois a mensagem final)
  // SUBSTITUI: sem isso, todo passo contaria duas vezes.
  const antes = estado.usd
  estado = unidade.apply(estado, amostra(1, 2, { inputTokens: 0, outputTokens: 1e6 }, 5))
  check('amostra repetida nao soma', Math.abs(estado.usd - antes) < 1e-12, { antes, depois: estado.usd })

  // E um quadro que nao tem uso nenhum nao mexe em nada.
  const comOutro = unidade.apply(estado, { type: 'request/header', time: Date.UTC(2026, 8, 14, 5, 0), data: {} })
  check('quadro sem uso nao muda o custo', comOutro === estado)

  check('a vista passa no esquema', unidade.schema.safeParse(unidade.view(estado)).success === true)
}

console.log('')
console.log(passaram + ' passaram, ' + falharam + ' falharam')
process.exit(falharam === 0 ? 0 : 1)
