/**
 * Busca de precos DE VERDADE (usa a internet).
 *
 *   node .dev/precos-online.mjs [modelo]
 *
 * O `self-test.mjs` prova o LEITOR contra o HTML guardado em fixtures (sem rede,
 * e por isso roda em qualquer lugar). Este aqui prova o caminho inteiro: buscar a
 * pagina oficial, casar o modelo e gravar o arquivo do usuario.
 *
 * E o mesmo caminho que o botao "Atualizar preco" da janelinha percorre.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buscarPrecosOficiais, gravarEstado, precosEmVigor, Config } from '../lib/index.js'

const modelo = process.argv[2] || 'deepseek-flash'
const dir = mkdtempSync(join(tmpdir(), 'session-cost-online-'))
const config = new Config({ estadoPath: join(dir, 'precos.json') })

console.log('em vigor antes  : ' + precosEmVigor(config).origem + ' (' + precosEmVigor(config).modelo + ')')
const oficial = await buscarPrecosOficiais(modelo)
console.log('lido da pagina  : ' + oficial.modelo)
console.log('modelos de la   : ' + oficial.modelos.join(', '))
console.log('precos          : ' + JSON.stringify(oficial.precos))
gravarEstado(config, { modelo: oficial.modelo, precos: oficial.precos, atualizadoEm: Date.now() })
const depois = precosEmVigor(config)
console.log('em vigor depois : ' + depois.origem + ' (' + depois.modelo + ')')
console.log('arquivo         : ' + join(dir, 'precos.json'))
console.log(JSON.parse(readFileSync(join(dir, 'precos.json'), 'utf8')).modelo === oficial.modelo
  ? 'OK: o que o usuario salvou manda sobre os precos de fabrica'
  : 'FALHA: o arquivo nao tem o modelo lido')
