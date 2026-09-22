/**
 * Provas do session-cost — rodam na JVM do Node, sem harness e sem navegador.
 *
 *   node .dev/self-test.mjs
 *
 * O que se prova aqui e a parte que pode mentir em silencio: a conta em dolar
 * (que depende do horario da amostra), a regra de substituicao (que impede um
 * passo de ser contado duas vezes) e a LEITURA da tabela oficial — esta ultima
 * contra o HTML de verdade guardado em `.dev/fixtures/precos.html`, sem rede.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ehPico, medir, minutosDe, definicao, Config, lerPrecos, precosEmVigor } from '../lib/index.js'

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
  [1, 2, 3, 4, 5],
)
check('pico cobra preco cheio', Math.abs(emPico.usd - 1.506) < 1e-9, emPico)

const foraPico = medir(
  { inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 },
  Date.UTC(2026, 8, 14, 5, 0),
  config,
  faixas,
  [1, 2, 3, 4, 5],
)
check('fora do pico custa metade', Math.abs(foraPico.usd - 0.753) < 1e-9, foraPico)

const escrita = medir(
  { inputTokens: 0, cacheWriteTokens: 1e6, outputTokens: 0 },
  Date.UTC(2026, 8, 14, 2, 0),
  config,
  faixas,
  [1, 2, 3, 4, 5],
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

console.log('leitura da tabela oficial (fixture do site, sem rede)')
{
  const html = readFileSync(new URL('./fixtures/precos.html', import.meta.url), 'utf8')
  const { modelos, precos } = lerPrecos(html)
  check('achou os dois modelos do cabecalho',
    modelos.includes('deepseek-flash') && modelos.includes('deepseek-v4-pro'), modelos)
  const flash = precos['deepseek-flash'] ?? {}
  check('flash: entrada com cache', flash.picoCacheHit === 0.006 && flash.foraCacheHit === 0.003, flash)
  check('flash: entrada sem cache', flash.picoCacheMiss === 0.3 && flash.foraCacheMiss === 0.15, flash)
  check('flash: saida', flash.picoSaida === 1.2 && flash.foraSaida === 0.6, flash)
  check('pro: saida e outra', precos['deepseek-v4-pro']?.picoSaida === 3.96, precos['deepseek-v4-pro'])
  const vazio = lerPrecos('<html><body><p>nada aqui</p></body></html>')
  check('pagina sem tabela nao quebra', vazio.modelos.length === 0 && Object.keys(vazio.precos).length === 0, vazio)
}

console.log('a tabela em vigor: o que VOCE salva manda sobre a de fabrica')
{
  const dir = mkdtempSync(join(tmpdir(), 'session-cost-'))
  const caminho = join(dir, 'precos.json')
  const config = new Config({ estadoPath: caminho })
  check('sem arquivo, valem os de fabrica', precosEmVigor(config).origem === 'fabrica', precosEmVigor(config))

  writeFileSync(caminho, JSON.stringify({
    modelo: 'deepseek-v4-pro',
    precos: { picoCacheHit: 0.044, picoCacheMiss: 1.32, picoSaida: 3.96, foraCacheHit: 0.022, foraCacheMiss: 0.66, foraSaida: 1.98 },
    atualizadoEm: 1234,
  }))
  const vigor = precosEmVigor(config)
  check('com arquivo, o do usuario manda', vigor.origem === 'usuario' && vigor.modelo === 'deepseek-v4-pro', vigor)
  check('e traz quando foi atualizado', vigor.atualizadoEm === 1234, vigor.atualizadoEm)

  // A conta passa a usar a tabela do usuario: 1M de saida no pico do pro = 3.96.
  const conta = medir({ outputTokens: 1e6 }, Date.UTC(2026, 8, 14, 2, 0), vigor.precos, [[60, 240], [360, 600]], [1, 2, 3, 4, 5])
  check('a conta usa a tabela atualizada', Math.abs(conta.usd - 3.96) < 1e-9, conta)

  writeFileSync(caminho, '{ isso nao e json')
  check('arquivo corrompido volta para os de fabrica', precosEmVigor(config).origem === 'fabrica')
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log(passaram + ' passaram, ' + falharam + ' falharam')
process.exit(falharam === 0 ? 0 : 1)
