/**
 * session-cost — metade host: quanto esta sessao custou, em dolar.
 *
 * O PRECO E ESCRITO PELO USUARIO
 * ===============================
 *
 * Este plugin NAO sabe o preco de nada. Ele usa uma tabela que voce mantem:
 *
 *   1. os valores de fabrica da configuracao (cordis.patch.yml), que sao os
 *      oficiais do deepseek-flash na data em que foram escritos;
 *   2. o que voce atualizar pela janelinha do rodape, que fica guardado em
 *      `$DSH_HOME/session-cost/precos.json` e MANDA sobre a configuracao.
 *
 * A janelinha (clique no valor, no rodape do composer) tem um campo para o modelo
 * e um botao que busca a tabela oficial na internet e reescreve o arquivo. E de
 * proposito que a busca e SOB DEMANDA: preco que muda sozinho no meio de uma conta
 * e pior que preco velho e declarado.
 *
 * POR QUE NO HOST E NAO NO NAVEGADOR
 * ==================================
 *
 * O preco da DeepSeek depende do INSTANTE de cada requisicao (fora do horario de
 * pico custa metade). Somar tudo com o preco de agora daria um numero que mente
 * (ate 2x) sempre que a sessao atravessasse a fronteira do pico.
 *
 * O log da sessao guarda cada amostra de uso com o `time` dela, entao a conta
 * exata so depende de quem sabe ler o log — e quem sabe e o host. Por isso o
 * plugin publica uma PROJECAO (`sessionCost`), do mesmo jeito que o
 * `dsh-token-meter` faz com `tokenUsage`: o navegador so desenha o numero.
 *
 * @module dsh-session-cost
 */
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const name = 'session-cost'

// Nada de dependencia obrigatoria: o plugin monta em qualquer perfil. A projecao
// so existe onde o servico `sessionProjections` existir, e a janelinha so existe
// onde houver `webServer` — os dois entram por `ctx.inject`.
const inject = []

/**
 * Precos oficiais do DeepSeek-V4.1-Flash (`deepseek-flash`), em US$ por 1M de
 * tokens, como publicados em https://api-docs.deepseek.com/quick_start/pricing
 * (tabela lida pela ultima vez em 22/set/2026).
 *
 * Sao o PONTO DE PARTIDA, nao a verdade: o arquivo do usuario manda sobre eles, e
 * o botao da janelinha reescreve esse arquivo a partir da pagina oficial.
 */
const PRECOS_FLASH = {
  picoCacheHit: 0.006,
  picoCacheMiss: 0.3,
  picoSaida: 1.2,
  foraCacheHit: 0.003,
  foraCacheMiss: 0.15,
  foraSaida: 0.6,
}

/**
 * Horario de pico da API, em UTC: 01:00-04:00 e 06:00-10:00, de segunda a
 * sexta (feriados chineses fora). Todo o resto e fora de pico — metade do preco.
 */
const PICO_PADRAO = ['01:00-04:00', '06:00-10:00']

const PAGINA_OFICIAL = 'https://api-docs.deepseek.com/quick_start/pricing/'

const Config = z.object({
  /** Modelo dos precos de fabrica, so para o rotulo. */
  modelo: z.string().default('deepseek-flash'),
  /** Onde guardar o que voce atualizar. Vazio = `$DSH_HOME/session-cost/precos.json`. */
  estadoPath: z.string().default(''),
  /** Rota da janelinha de precos. */
  rotaPrecos: z.string().default('/session-cost/precos'),
  /** Janelas de pico em UTC, no formato HH:MM-HH:MM. */
  janelasDePico: z.array(z.string()).default(PICO_PADRAO),
  /** Dias de pico: 1 = segunda ... 7 = domingo (padrao: dias uteis). */
  diasDePico: z.array(z.number()).default([1, 2, 3, 4, 5]),
  /** US$ por 1M de tokens de entrada que VEIO DO CACHE, em horario de pico. */
  picoCacheHit: z.number().default(PRECOS_FLASH.picoCacheHit),
  /** US$ por 1M de tokens de entrada SEM cache, em horario de pico. */
  picoCacheMiss: z.number().default(PRECOS_FLASH.picoCacheMiss),
  /** US$ por 1M de tokens de saida, em horario de pico. */
  picoSaida: z.number().default(PRECOS_FLASH.picoSaida),
  /** Os mesmos tres, fora do horario de pico (metade do pico, na DeepSeek). */
  foraCacheHit: z.number().default(PRECOS_FLASH.foraCacheHit),
  foraCacheMiss: z.number().default(PRECOS_FLASH.foraCacheMiss),
  foraSaida: z.number().default(PRECOS_FLASH.foraSaida),
})

/**
 * Onde mora o que o usuario atualizou.
 * @param config - configuracao resolvida.
 * @returns caminho absoluto do arquivo.
 */
function caminhoDoEstado(config) {
  if (config.estadoPath) return config.estadoPath
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'session-cost', 'precos.json')
}

/**
 * Le o arquivo do usuario, tolerando ausencia e corrupcao.
 * @param config - configuracao resolvida.
 * @returns o conteudo salvo, ou null.
 */
function lerEstado(config) {
  try {
    const caminho = caminhoDoEstado(config)
    if (!existsSync(caminho)) return null
    const dados = JSON.parse(readFileSync(caminho, 'utf8'))
    return dados && typeof dados === 'object' ? dados : null
  } catch {
    return null
  }
}

/**
 * Grava o que o usuario atualizou, de forma atomica.
 * @param config - configuracao resolvida.
 * @param dados - conteudo a gravar.
 * @returns true quando gravou.
 */
function gravarEstado(config, dados) {
  try {
    const caminho = caminhoDoEstado(config)
    mkdirSync(dirname(caminho), { recursive: true })
    const temporario = caminho + '.tmp'
    writeFileSync(temporario, JSON.stringify(dados, null, 2), { mode: 0o600 })
    renameSync(temporario, caminho)
    return true
  } catch {
    return false
  }
}

/**
 * Tabela em vigor: o que o usuario salvou manda; sem arquivo, a configuracao.
 * @param config - configuracao resolvida.
 * @returns precos + de onde vieram + quando foram atualizados.
 */
function precosEmVigor(config) {
  const salvo = lerEstado(config)
  if (salvo?.precos && typeof salvo.precos === 'object') {
    return {
      modelo: String(salvo.modelo ?? config.modelo),
      precos: salvo.precos,
      origem: 'usuario',
      atualizadoEm: Number(salvo.atualizadoEm ?? 0),
    }
  }
  return {
    modelo: config.modelo,
    precos: {
      picoCacheHit: config.picoCacheHit,
      picoCacheMiss: config.picoCacheMiss,
      picoSaida: config.picoSaida,
      foraCacheHit: config.foraCacheHit,
      foraCacheMiss: config.foraCacheMiss,
      foraSaida: config.foraSaida,
    },
    origem: 'fabrica',
    atualizadoEm: 0,
  }
}

/**
 * Texto de uma celula de HTML, sem tags.
 * @param bruto - conteudo da celula.
 * @returns texto limpo.
 */
function textoDaCelula(bruto) {
  return String(bruto)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Le a tabela de precos da pagina oficial da DeepSeek.
 *
 * A pagina e Docusaurus: a tabela JA VEM pronta no HTML, entao nao precisa de
 * navegador nem de API paga. O que se faz aqui e andar pelas linhas (<tr>) e
 * celulas (<td>), achar o cabecalho dos modelos e casar cada rotulo de preco com
 * a coluna do modelo.
 *
 * Funcao pura de proposito: o teste roda contra o HTML de verdade guardado em
 * `.dev/fixtures/precos.html`, sem rede.
 *
 * @param html - pagina inteira, como veio da rede.
 * @returns {modelos: string[], precos: Record<string, object>} o que deu para ler.
 */
function lerPrecos(html) {
  const linhas = [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((linha) =>
    [...linha[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((celula) => textoDaCelula(celula[1])),
  )

  // A linha do cabecalho e a que tem uma celula exatamente 'MODEL'; os modelos
  // sao as celulas seguintes, com a nota de rodape (1)/(2) removida.
  const cabecalho = linhas.find((cels) => cels.some((c) => c.toUpperCase() === 'MODEL'))
  if (!cabecalho) return { modelos: [], precos: {} }
  const inicio = cabecalho.findIndex((c) => c.toUpperCase() === 'MODEL')
  const modelos = cabecalho
    .slice(inicio + 1)
    .map((c) => c.replace(/\(\d+\)/g, '').trim())
    .filter((c) => /^[a-z0-9][a-z0-9._-]*$/i.test(c))
  if (modelos.length === 0) return { modelos: [], precos: {} }

  const precos = {}
  for (const modelo of modelos) precos[modelo] = {}

  for (const cels of linhas) {
    const rotulo = cels.join(' ').toUpperCase()
    const tipo = rotulo.includes('CACHE HIT')
      ? 'CacheHit'
      : rotulo.includes('CACHE MISS')
        ? 'CacheMiss'
        : rotulo.includes('OUTPUT')
          ? 'Saida'
          : null
    if (!tipo) continue
    const janela = rotulo.includes('OFF-PEAK') ? 'fora' : rotulo.includes('PEAK') ? 'pico' : null
    if (!janela) continue
    const valores = cels.filter((c) => /^\$[0-9]+(\.[0-9]+)?$/.test(c))
    modelos.forEach((modelo, indice) => {
      const valor = valores[indice]
      if (valor === undefined) return
      precos[modelo][janela + tipo] = Number(valor.slice(1))
    })
  }

  // A DeepSeek publica as duas janelas; se vier so uma, a outra e metade.
  for (const modelo of modelos) {
    const tabela = precos[modelo]
    for (const campo of ['CacheHit', 'CacheMiss', 'Saida']) {
      if (tabela['pico' + campo] === undefined && tabela['fora' + campo] !== undefined) {
        tabela['pico' + campo] = Number((tabela['fora' + campo] * 2).toFixed(6))
      }
      if (tabela['fora' + campo] === undefined && tabela['pico' + campo] !== undefined) {
        tabela['fora' + campo] = Number((tabela['pico' + campo] / 2).toFixed(6))
      }
    }
  }

  return { modelos, precos }
}

/**
 * Busca a tabela oficial e devolve os precos de um modelo.
 *
 * @param modelo - id do modelo, como o usuario escreveu (aceita caixa alta e
 *   espacos; casa tambem por prefixo, para `deepseek-flash` achar
 *   `deepseek-flash(1)` do cabecalho).
 * @returns objeto com precos + o que foi lido da pagina.
 * @throws quando a rede falha ou o modelo nao esta na tabela.
 */
async function buscarPrecosOficiais(modelo) {
  const resposta = await fetch(PAGINA_OFICIAL, { headers: { 'user-agent': 'dsh-session-cost' } })
  if (!resposta.ok) throw new Error('a pagina oficial respondeu HTTP ' + resposta.status)
  const html = await resposta.text()
  const { modelos, precos } = lerPrecos(html)
  const alvo = String(modelo ?? '').trim().toLowerCase()
  const encontrado = modelos.find((m) => m.toLowerCase() === alvo)
    ?? modelos.find((m) => m.toLowerCase().startsWith(alvo) || alvo.startsWith(m.toLowerCase()))
  if (!encontrado) {
    throw new Error('nao achei "' + modelo + '" na tabela oficial. Modelos de la: ' + modelos.join(', '))
  }
  return { modelo: encontrado, precos: precos[encontrado], modelos }
}

/* ------------------------------------------------------------------ projecao */

/**
 * Converte HH:MM em minutos desde a meia-noite.
 * @param texto - horario no formato HH:MM.
 * @returns minutos, ou null quando o texto nao serve.
 */
function minutosDe(texto) {
  const partes = String(texto).trim().split(':')
  if (partes.length !== 2) return null
  const hora = Number(partes[0])
  const minuto = Number(partes[1])
  if (!Number.isFinite(hora) || !Number.isFinite(minuto)) return null
  if (hora < 0 || hora > 23 || minuto < 0 || minuto > 59) return null
  return hora * 60 + minuto
}

/**
 * Le a configuracao das janelas uma vez, em minutos.
 * @param config - configuracao resolvida do plugin.
 * @returns lista de pares [inicio, fim) em minutos UTC.
 */
function janelas(config) {
  const faixas = []
  for (const texto of config.janelasDePico ?? []) {
    const [inicio, fim] = String(texto).split('-')
    const a = minutosDe(inicio)
    const b = minutosDe(fim)
    if (a === null || b === null) continue
    faixas.push([a, b])
  }
  return faixas
}

/**
 * Este instante cai no horario de pico?
 * @param ms - instante da amostra (epoch em ms).
 * @param faixas - janelas em minutos UTC.
 * @param dias - dias uteis de pico (1 = segunda).
 * @returns true quando a API cobra preco cheio.
 */
function ehPico(ms, faixas, dias) {
  const quando = new Date(ms)
  // getUTCDay(): 0 = domingo. Aqui domingo vira 7, para casar com a tabela.
  const dia = quando.getUTCDay() === 0 ? 7 : quando.getUTCDay()
  if (!dias.includes(dia)) return false
  const agora = quando.getUTCHours() * 60 + quando.getUTCMinutes()
  return faixas.some(([inicio, fim]) => agora >= inicio && agora < fim)
}

/**
 * Quanto custou uma amostra de uso, no instante dela.
 *
 * A DeepSeek nao publica preco separado para ESCRITA de cache: ela entra pela
 * tarifa de entrada sem cache. Por isso cacheWriteTokens vai junto com
 * inputTokens na mesma conta.
 *
 * @param uso - usage do evento (contagens de token).
 * @param ms - instante do evento.
 * @param tabela - precos em vigor (do usuario ou de fabrica).
 * @param faixas - janelas de pico em minutos.
 * @param dias - dias de pico.
 * @returns retrato da amostra, em US$ e em tokens.
 */
function medir(uso, ms, tabela, faixas, dias) {
  const pico = ehPico(ms, faixas, dias)
  const semCache = Number(uso.inputTokens ?? 0)
  const doCache = Number(uso.cacheReadTokens ?? 0)
  const escrita = Number(uso.cacheWriteTokens ?? 0)
  const saida = Number(uso.outputTokens ?? 0)
  const tarifa = pico
    ? { hit: tabela.picoCacheHit, miss: tabela.picoCacheMiss, out: tabela.picoSaida }
    : { hit: tabela.foraCacheHit, miss: tabela.foraCacheMiss, out: tabela.foraSaida }
  const usd =
    ((semCache + escrita) / 1e6) * Number(tarifa.miss ?? 0) +
    (doCache / 1e6) * Number(tarifa.hit ?? 0) +
    (saida / 1e6) * Number(tarifa.out ?? 0)
  return { usd, pico, semCache, doCache, escrita, saida }
}

/** A vista que o navegador recebe (e que o esquema valida). */
const vista = zod.object({
  modelo: zod.string(),
  /** Modelo que a SESSAO usou de verdade, lido do cabecalho da requisicao. */
  modeloSessao: zod.string().optional(),
  /** 'fabrica' (configuracao) ou 'usuario' (atualizado pela janelinha). */
  origem: zod.string(),
  atualizadoEm: zod.number().nonnegative(),
  usd: zod.number().nonnegative(),
  usdPico: zod.number().nonnegative(),
  semCache: zod.number().nonnegative(),
  doCache: zod.number().nonnegative(),
  escrita: zod.number().nonnegative(),
  saida: zod.number().nonnegative(),
  amostras: zod.number().nonnegative(),
}).strict()

/**
 * Monta a definicao da projecao.
 *
 * Os precos sao lidos a CADA dobra (`precosEmVigor`), entao o que voce atualiza na
 * janelinha vale a partir do proximo passo — o que ja foi contado fica como estava,
 * e isso e proposital: o numero antigo foi cobrado com o preco da epoca.
 *
 * @param config - configuracao do plugin.
 * @returns a definicao registrada em `sessionProjections`.
 */
function definicao(config) {
  const faixas = janelas(config)
  const dias = config.diasDePico ?? []
  const vazio = {
    usd: 0, usdPico: 0, semCache: 0, doCache: 0, escrita: 0, saida: 0, amostras: 0,
    ultima: null, modeloSessao: undefined,
  }
  return {
    key: 'sessionCost',
    schema: vista,
    stateVersion: 2,
    init: () => ({ ...vazio }),
    apply: (estado, evento) => {
      // O modelo da sessao vem do cabecalho de cada requisicao: e o que permite o
      // rodape avisar "a sessao esta em outro modelo; estes precos sao de X".
      if (evento.type === 'request/header') {
        const modelo = evento.data?.header?.config?.model
        if (typeof modelo === 'string' && modelo && modelo !== estado.modeloSessao) {
          return { ...estado, modeloSessao: modelo }
        }
        return estado
      }

      // As duas formas de amostra, como o token-meter: chunk de uso (adiantada)
      // e mensagem do assistente (final).
      let turn
      let step
      let uso
      if (evento.type === 'assistant/chunk' && evento.data?.chunk?.type === 'usage') {
        turn = evento.data.turn
        step = evento.data.step
        uso = evento.data.chunk.usage
      } else if (evento.type === 'assistant/message' && evento.data?.usage !== undefined) {
        turn = evento.data.turn
        step = evento.data.step
        uso = evento.data.usage
      }
      if (!uso) return estado

      const tabela = precosEmVigor(config).precos
      const agora = medir(uso, Number(evento.time ?? Date.now()), tabela, faixas, dias)
      // Mesmo passo de novo: a amostra NOVA substitui a antiga, nao soma.
      const anterior = estado.ultima && estado.ultima.turn === turn && estado.ultima.step === step
        ? estado.ultima
        : null
      return {
        usd: estado.usd - (anterior?.usd ?? 0) + agora.usd,
        usdPico: estado.usdPico - (anterior?.pico ? anterior.usd : 0) + (agora.pico ? agora.usd : 0),
        semCache: estado.semCache - (anterior?.semCache ?? 0) + agora.semCache,
        doCache: estado.doCache - (anterior?.doCache ?? 0) + agora.doCache,
        escrita: estado.escrita - (anterior?.escrita ?? 0) + agora.escrita,
        saida: estado.saida - (anterior?.saida ?? 0) + agora.saida,
        amostras: estado.amostras - (anterior ? 1 : 0) + 1,
        ultima: { turn, step, ...agora },
        modeloSessao: estado.modeloSessao,
      }
    },
    view: (estado) => {
      const vigor = precosEmVigor(config)
      return {
        modelo: vigor.modelo,
        ...(estado.modeloSessao === undefined ? {} : { modeloSessao: estado.modeloSessao }),
        origem: vigor.origem,
        atualizadoEm: vigor.atualizadoEm,
        usd: estado.usd,
        usdPico: estado.usdPico,
        semCache: estado.semCache,
        doCache: estado.doCache,
        escrita: estado.escrita,
        saida: estado.saida,
        amostras: estado.amostras,
      }
    },
  }
}

/* -------------------------------------------------------------------- rotas */

/**
 * Responde JSON.
 * @param res - resposta HTTP.
 * @param status - codigo.
 * @param corpo - conteudo.
 */
function responderJson(res, status, corpo) {
  const texto = JSON.stringify(corpo)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(texto),
  })
  res.end(texto)
}

/**
 * Le o corpo JSON de uma requisicao.
 * @param req - requisicao.
 * @returns objeto (vazio quando nao ha corpo).
 */
function lerCorpo(req) {
  return new Promise((resolve) => {
    const partes = []
    req.on('data', (pedaco) => partes.push(pedaco))
    req.on('end', () => {
      const bruto = Buffer.concat(partes).toString('utf8').trim()
      if (!bruto) return resolve({})
      try {
        resolve(JSON.parse(bruto))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}) )
  })
}

/**
 * Monta o plugin.
 * @param ctx - contexto do harness.
 * @param config - configuracao ja validada pelo Loader.
 */
function apply(ctx, config) {
  ctx.inject(['sessionProjections'], (escopo) => {
    escopo.sessionProjections.register(definicao(config))
  })

  // A janelinha precisa de HTTP, mas quem decide isso e o `ctx.inject`: quem sobe
  // DEPOIS do plugin nao existe neste instante, e checar aqui com `return` matava
  // a rota em silencio — foi o que aconteceu na primeira versao (a pagina respondia
  // com o HTML do app, porque a rota nunca tinha sido registrada). O callback roda
  // quando (e se) houver webserver; perfil sem HTTP nao gasta nada.
  ctx.inject(['webServer'], (escopo) => {
    escopo.effect(
      () => escopo.webServer.register({
        kind: 'exact',
        path: config.rotaPrecos,
        handler: async (req, res) => {
          const vigor = precosEmVigor(config)
          if (req.method === 'GET') {
            responderJson(res, 200, { ok: true, ...vigor, fonte: PAGINA_OFICIAL })
            return
          }
          const corpo = await lerCorpo(req)
          const modelo = String(corpo.model ?? corpo.modelo ?? vigor.modelo)
          try {
            const oficial = await buscarPrecosOficiais(modelo)
            gravarEstado(config, {
              modelo: oficial.modelo,
              precos: oficial.precos,
              atualizadoEm: Date.now(),
              fonte: PAGINA_OFICIAL,
            })
            responderJson(res, 200, {
              ok: true,
              modelo: oficial.modelo,
              precos: oficial.precos,
              modelos: oficial.modelos,
              origem: 'usuario',
              atualizadoEm: Date.now(),
              fonte: PAGINA_OFICIAL,
            })
          } catch (erro) {
            responderJson(res, 502, {
              ok: false,
              erro: String(erro?.message ?? erro),
              fonte: PAGINA_OFICIAL,
            })
          }
        },
      }),
      'session-cost: janelinha de precos',
    )
  })
}

export {
  name, inject, Config, apply, medir, ehPico, minutosDe, definicao, lerPrecos, precosEmVigor,
  buscarPrecosOficiais, gravarEstado, caminhoDoEstado,
}
