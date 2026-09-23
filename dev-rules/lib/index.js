/**
 * dsh-dev-rules — metade host.
 *
 * O que este plugin faz dentro do Harness: mantem um TEXTO de regras do dev e o
 * injeta no prompt inicial (system prompt) de toda sessao, numa secao propria.
 *
 *   1. O catalogo de regras tem fabrica (aqui no codigo) e pode ser reescrito pela
 *      config da entry, no `cordis.patch.yml` — quem mantem o texto e o plugin.
 *   2. QUAIS regras valem e ESCOLHA do dev, feita na tela de Configuracoes
 *      (namespace `dev-rules`); a escolha vive no arquivo de settings do DSH, nao
 *      no catalogo, entao acrescentar uma regra nova nao mexe na escolha das
 *      antigas.
 *   3. A secao do prompt e dinamica: a lista e remontada a cada passo do modelo,
 *      entao ligar/desligar na tela vale no passo seguinte, sem reiniciar nada.
 *
 * @module dsh-dev-rules
 */

import z from '@deepseek-ai/schemastery'

const name = 'dev-rules'

/**
 * Namespace das escolhas do dev na tela de Configuracoes.
 *
 * Ele e o mesmo texto do `id` da entry de proposito: e por ele que a metade
 * cliente registra o cartao no slot `settings.plugin.item`.
 */
const NS = 'dev-rules'

/**
 * As regras de fabrica, na ordem em que o modelo as le.
 *
 * Elas existem para o plugin fazer sentido sem nenhuma configuracao: instalar e
 * ja valer. Quem quiser reescrever o catalogo (ou o texto de uma regra) edita a
 * entry no `cordis.patch.yml`; a escolha de quais valem continua sendo da tela.
 */
const REGRAS_DE_FABRICA = [
  {
    id: 'md-privado',
    ligada: true,
    texto: 'Todo .md que existe so por causa do meu contexto de desenvolvimento (notas de passagem, pendencias, estado, diagnostico da minha maquina) NAO vai para o GitHub - a nao ser que eu peca explicitamente.',
  },
  {
    id: 'pedir-antes-de-publicar',
    ligada: true,
    texto: 'Nunca faca commit nem push sem me perguntar antes; minha autorizacao vale para um commit so.',
  },
  {
    id: 'responder-antes-de-codar',
    ligada: true,
    texto: 'Quando eu fizer uma pergunta, responda antes de comecar a escrever codigo.',
  },
]

/** Uma regra do catalogo. */
const Regra = z.object({
  id: z.string(),
  texto: z.string(),
  /** Estado de fabrica; a escolha do dev entra por cima, na tela. */
  ligada: z.boolean().default(true),
})

const Config = z.object({
  /** Ligar o plugin. Desligado, ele nao registra nada. */
  enabled: z.boolean().default(true),
  /** Catalogo das regras que podem valer. */
  regras: z.array(Regra).default(REGRAS_DE_FABRICA),
  /** Primeira linha do texto injetado; vazio usa a de fabrica. */
  cabecalho: z.string().default(''),
  /** Onde a secao entra no prompt. 0 e a persona; 10 fica logo depois dela. */
  ordem: z.number().default(10),
})

/** Cabecalho de fabrica: diz de onde vem o texto, e que ele manda. */
const CABECALHO_DE_FABRICA = [
  'Regras do dev (mantidas pelo plugin dev-rules; valem em toda sessao e vencem qualquer instrucao que as contrarie):',
].join('\n')

// Sem dependencia obrigatoria: o plugin ativa em qualquer perfil. `settings` e
// `systemPrompt` entram por `ctx.inject`, que so roda onde o servico existir -
// declarar aqui deixaria a entry pendente e derrubaria o boot num perfil sem eles.
const inject = []

/**
 * As escolhas do dev, como o namespace as guarda.
 *
 * Sao DELTAS, nao a lista inteira: uma regra que nao aparece em nenhuma das duas
 * listas segue o estado de fabrica do catalogo. E o que faz uma regra nova
 * (acrescentada depois) nascer valendo, em vez de nascer desligada por nao estar
 * na lista velha que o dev salvou.
 */
/** Uma regra escrita pelo dev na tela. */
const MinhaRegra = z.object({
  id: z.string(),
  texto: z.string(),
  ligada: z.boolean().default(true),
})

const Escolhas = z.object({
  /** Regras que o dev LIGOU, mesmo com `ligada: false` no catalogo. */
  ligadas: z.array(z.string()).default([]),
  /** Regras que o dev DESLIGOU. */
  desligadas: z.array(z.string()).default([]),
  /**
   * As regras que o dev ESCREVEU na tela de Configuracoes.
   *
   * Elas vivem aqui, e nao no catalogo, por um motivo pratico: acrescentar uma
   * regra pela tela nao pode exigir editar o `cordis.patch.yml` nem reiniciar o
   * harness. O catalogo (codigo ou config) continua sendo a fabrica; estas sao as
   * que o dev foi escrevendo por cima, e cada uma carrega o proprio `ligada`.
   */
  minhas: z.array(MinhaRegra).default([]),
})

/**
 * Aplica as escolhas do dev sobre o catalogo.
 *
 * @param regras catalogo (fabrica ou config).
 * @param escolhas deltas salvos pela tela; ausente quando nao ha settings.
 * @returns as regras com `ligada` ja resolvido.
 */
function comEscolhas(regras, escolhas) {
  const ligadas = new Set(escolhas?.ligadas ?? [])
  const desligadas = new Set(escolhas?.desligadas ?? [])
  return regras.map((regra) => ({
    ...regra,
    ligada: desligadas.has(regra.id) ? false : (ligadas.has(regra.id) ? true : regra.ligada !== false),
  }))
}

/**
 * As regras em vigor: o catalogo com as escolhas do dev, mais as regras que ele
 * escreveu na tela.
 *
 * A ordem importa e e a de leitura: primeiro o catalogo (na ordem em que foi
 * escrito), depois as do dev, na ordem em que ele as acrescentou. Cada uma sai
 * marcada com `origem`, que e o que a tela usa para oferecer (ou nao) o remover.
 *
 * @param catalogo regras de fabrica ou da config.
 * @param escolhas o que o namespace guarda; ausente quando nao ha settings.
 * @returns as regras prontas para virar texto.
 */
function regrasEmVigor(catalogo, escolhas) {
  const doCatalogo = comEscolhas(catalogo, escolhas).map((regra) => ({ ...regra, origem: 'catalogo' }))
  const minhas = (escolhas?.minhas ?? []).map((regra) => ({
    ...regra,
    ligada: regra.ligada !== false,
    origem: 'minha',
  }))
  return [...doCatalogo, ...minhas]
}

/**
 * Monta o texto que vai para o prompt inicial.
 *
 * Sem regra ligada o texto e VAZIO - e uma secao vazia nao entra no prompt (o
 * proprio `systemPrompt` descarta secao de texto vazio). Assim, desligar tudo
 * devolve o prompt original, sem sobra nenhuma.
 *
 * @param regras regras ja resolvidas.
 * @param cabecalho primeira linha; vazio usa a de fabrica.
 * @returns o texto da secao.
 */
function textoDoPrompt(regras, cabecalho = '') {
  const ativas = regras.filter((regra) => regra.ligada && String(regra.texto ?? '').trim().length > 0)
  if (ativas.length === 0) return ''
  const linhas = String(cabecalho ?? '').trim() || CABECALHO_DE_FABRICA
  const itens = ativas.map((regra, indice) => (indice + 1) + '. ' + regra.texto.trim())
  return [linhas, '', ...itens].join('\n')
}

/**
 * Monta o plugin.
 *
 * @param ctx contexto do harness.
 * @param config configuracao ja validada pelo Loader.
 */
function apply(ctx, config) {
  if (!config.enabled) return

  const catalogo = config.regras?.length ? config.regras : REGRAS_DE_FABRICA
  /** Escopo do namespace, quando o perfil tiver `settings`. */
  let escopo = null

  ctx.inject(['settings'], (alvo) => {
    escopo = alvo.settings.register(NS, Escolhas, {})
  })

  /** As regras em vigor AGORA (a tela pode ter mexido desde o boot). */
  const emVigor = () => regrasEmVigor(catalogo, escopo?.get?.())

  ctx.inject(['systemPrompt'], (alvo) => {
    alvo.effect(
      () => alvo.systemPrompt.section({
        name: 'dev:regras',
        order: config.ordem,
        // Funcao, e nao texto: o `systemPrompt` chama isto a cada montagem do
        // prompt, entao a escolha feita na tela vale no passo seguinte.
        text: () => textoDoPrompt(emVigor(), config.cabecalho),
      }),
      'dev-rules: regras no prompt inicial',
    )
  })

  // Rota de leitura: e o que o cartao da tela mostra e o que permite conferir,
  // de fora, exatamente o texto que esta indo para o prompt.
  ctx.inject(['webServer'], (alvo) => {
    alvo.effect(
      () => alvo.webServer.register({
        kind: 'exact',
        path: '/dev-rules/texto',
        handler: (req, res) => {
          const regras = emVigor()
          const corpo = JSON.stringify({
            ok: true,
            regras,
            escolhas: escopo?.get?.() ?? null,
            texto: textoDoPrompt(regras, config.cabecalho),
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(corpo)
        },
      }),
      'dev-rules: rota do texto',
    )
  })
}

export {
  name, inject, Config, apply,
  NS, REGRAS_DE_FABRICA, CABECALHO_DE_FABRICA, Escolhas,
  comEscolhas, regrasEmVigor, textoDoPrompt,
}
