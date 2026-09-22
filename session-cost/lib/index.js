/**
 * session-cost — metade host: quanto esta sessao custou, em dolar.
 *
 * POR QUE NO HOST E NAO NO NAVEGADOR
 * ===================================
 *
 * O preco da DeepSeek depende do INSTANTE de cada requisicao: fora do horario
 * de pico custa metade. Somar tudo com o preco de agora daria um numero que
 * mente (ate 2x) sempre que a sessao atravessasse a fronteira do pico.
 *
 * O log da sessao guarda cada amostra de uso com o `time` dela, entao a conta
 * exata so depende de quem sabe ler o log — e quem sabe e o host. Por isso o
 * plugin publica uma PROJECAO (`sessionCost`), do mesmo jeito que o
 * `dsh-token-meter` faz com `tokenUsage`: o navegador so desenha o numero.
 *
 * O que conta como amostra: `assistant/chunk` com chunk de uso (amostra
 * adiantada, que sobrevive a uma requisicao que falhou) e `assistant/message`
 * (amostra final do mesmo passo). A repeticao SUBSTITUI, nunca soma — igual ao
 * token-meter, senao cada passo seria contado duas vezes.
 *
 * @module dsh-session-cost
 */
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'

const name = 'session-cost'

// Nada de dependencia obrigatoria: o plugin monta em qualquer perfil. A
// projecao so existe onde o servico `sessionProjections` existir, e e para isso
// que serve o `ctx.inject` abaixo.
const inject = []

/**
 * Precos oficiais do DeepSeek-V4.1-Flash (`deepseek-flash`), em US$ por 1M de
 * tokens, como publicados em https://api-docs.deepseek.com/quick_start/pricing
 * (tabela lida em 18/set/2026).
 *
 * Eles ficam na CONFIGURACAO, nao no codigo: a DeepSeek avisa que muda, e
 * quando mudar e para editar um numero no cordis.patch.yml, sem tocar aqui.
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
 * sexta. Todo o resto e fora de pico (metade do preco).
 */
const PICO_PADRAO = ['01:00-04:00', '06:00-10:00']

const Config = z.object({
  /** Nome do modelo, so para o rotulo que o navegador mostra. */
  modelo: z.string().default('deepseek-flash'),
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
 * tarifa de entrada sem cache. Por isso cacheWriteToken vai junto com
 * inputTokens na mesma conta.
 *
 * @param uso - usage do evento (contagens de token).
 * @param ms - instante do evento.
 * @param config - precos resolvidos.
 * @param faixas - janelas de pico em minutos.
 * @returns retrato da amostra, em US$ e em tokens.
 */
function medir(uso, ms, config, faixas) {
  const pico = ehPico(ms, faixas, config.diasDePico ?? [])
  const semCache = Number(uso.inputTokens ?? 0)
  const doCache = Number(uso.cacheReadTokens ?? 0)
  const escrita = Number(uso.cacheWriteTokens ?? 0)
  const saida = Number(uso.outputTokens ?? 0)
  const tarifa = pico
    ? { hit: config.picoCacheHit, miss: config.picoCacheMiss, out: config.picoSaida }
    : { hit: config.foraCacheHit, miss: config.foraCacheMiss, out: config.foraSaida }
  const usd =
    ((semCache + escrita) / 1e6) * tarifa.miss +
    (doCache / 1e6) * tarifa.hit +
    (saida / 1e6) * tarifa.out
  return { usd, pico, semCache, doCache, escrita, saida }
}

/** A vista que o navegador recebe (e que o esquema valida). */
const vista = zod.object({
  modelo: zod.string(),
  usd: zod.number().nonnegative(),
  usdPico: zod.number().nonnegative(),
  semCache: zod.number().nonnegative(),
  doCache: zod.number().nonnegative(),
  escrita: zod.number().nonnegative(),
  saida: zod.number().nonnegative(),
  amostras: zod.number().nonnegative(),
}).strict()

/**
 * Monta a definicao da projecao com os precos resolvidos.
 * @param config - configuracao do plugin.
 * @returns a definicao registrada em `sessionProjections`.
 */
function definicao(config) {
  const faixas = janelas(config)
  const vazio = {
    usd: 0, usdPico: 0, semCache: 0, doCache: 0, escrita: 0, saida: 0, amostras: 0, ultima: null,
  }
  return {
    key: 'sessionCost',
    schema: vista,
    stateVersion: 1,
    init: () => ({ ...vazio }),
    apply: (estado, evento) => {
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

      const agora = medir(uso, Number(evento.time ?? Date.now()), config, faixas)
      // Mesmo passo de novo: a amostra NOVA substitui a antiga, nao soma.
      const anterior = estado.ultima && estado.ultima.turn === turn && estado.ultima.step === step
        ? estado.ultima
        : null
      const proximo = {
        usd: estado.usd - (anterior?.usd ?? 0) + agora.usd,
        usdPico: estado.usdPico - (anterior?.pico ? anterior.usd : 0) + (agora.pico ? agora.usd : 0),
        semCache: estado.semCache - (anterior?.semCache ?? 0) + agora.semCache,
        doCache: estado.doCache - (anterior?.doCache ?? 0) + agora.doCache,
        escrita: estado.escrita - (anterior?.escrita ?? 0) + agora.escrita,
        saida: estado.saida - (anterior?.saida ?? 0) + agora.saida,
        amostras: estado.amostras - (anterior ? 1 : 0) + 1,
        ultima: { turn, step, ...agora },
      }
      return proximo
    },
    view: (estado) => ({
      modelo: config.modelo,
      usd: estado.usd,
      usdPico: estado.usdPico,
      semCache: estado.semCache,
      doCache: estado.doCache,
      escrita: estado.escrita,
      saida: estado.saida,
      amostras: estado.amostras,
    }),
  }
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
}

export { name, inject, Config, apply, medir, ehPico, minutosDe, definicao }
