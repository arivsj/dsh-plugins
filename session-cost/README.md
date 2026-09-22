# dsh-session-cost

Mostra **quanto esta sessao custou, em US$**, numa linha fina logo abaixo do
composer do DeepSeek Harness.

```
US$ 0,0142 · 336k entrada (96% cache) · 4,1k saida
```

Passar o mouse mostra o detalhe: modelo, quanto saiu no horario de pico e
quanto saiu fora dele, e as contagens de token.

## O preco e escrito por VOCE

Isto e a parte que mais importa entender: **este plugin nao sabe o preco de
nada.** Ele nao consulta a DeepSeek sozinho, nao adivinha, nao embute uma tabela
secreta. Ele usa uma tabela que **voce** mantem, em duas camadas:

1. **os valores de fabrica** da configuracao (`cordis.patch.yml`) — que sao os
   oficiais do `deepseek-flash` na data em que foram escritos;
2. **o que voce atualizar pela janelinha** — guardado em
   `~/.dsh/session-cost/precos.json`, e **manda** sobre a configuracao.

### Como atualizar (pela tela)

**Clique no valor** no rodape do composer. Abre uma janelinha com:

- um **campo com o modelo** que voce esta usando (ja vem preenchido com o modelo
  que a sessao usou de verdade, lido do log);
- a **tabela em vigor** (pico e fora do pico) e de onde ela veio;
- o botao **Atualizar preco** — ele busca a pagina oficial da DeepSeek
  (<https://api-docs.deepseek.com/quick_start/pricing>), le a tabela, guarda o
  arquivo e ja vale para o proximo passo.

Se a sessao estiver num modelo diferente do da tabela, a linha do rodape avisa
(`· preco de <modelo>`) e a janelinha explica: e o caso de voce ter trocado de
modelo no Harness e os precos ainda serem do anterior.

### Como atualizar (pela configuracao)

Sem tocar em JavaScript: edite a entry em `$DSH_HOME/cordis.patch.yml`.

```yaml
- insert:
    - id: session-cost
      name: 'dsh-session-cost'
      config:
        modelo: deepseek-flash
        picoCacheHit: 0.006
        picoCacheMiss: 0.30
        picoSaida: 1.20
        foraCacheHit: 0.003
        foraCacheMiss: 0.15
        foraSaida: 0.60
```

### Por que a busca e SOB DEMANDA

Preco que muda sozinho no meio de uma conta e pior que preco velho e declarado:
o numero que ja estava na tela deixaria de ter explicacao. Aqui nada se move sem
um clique — e quando se move, o que **ja foi contado fica como estava**, porque
aquilo foi cobrado com o preco da epoca.

## Por que o numero e exato

O preco da API DeepSeek **muda com o horario**: fora do pico custa metade. Somar
os tokens da sessao com o preco de agora daria um numero errado (ate 2x) sempre
que a sessao atravessasse a fronteira do pico.

Por isso a conta e feita no **host**, dobrando o log da sessao: cada amostra de
uso (`assistant/chunk` com chunk de uso e `assistant/message`) carrega o proprio
instante, entao cada pedaco e tarifado no horario em que aconteceu. O navegador
so desenha o resultado.

| | pico | fora do pico |
|---|---|---|
| entrada, cache hit | US$ 0,006 | US$ 0,003 |
| entrada, cache miss | US$ 0,30 | US$ 0,15 |
| saida | US$ 1,20 | US$ 0,60 |

Valores por 1M de tokens, do modelo `deepseek-flash` (DeepSeek-V4.1-Flash),
conforme a [tabela oficial](https://api-docs.deepseek.com/quick_start/pricing)
lida em 18/set/2026.

**Horario de pico:** 01:00-04:00 e 06:00-10:00 UTC, de segunda a sexta. Todo o
resto e fora de pico. Em Brasilia (UTC-3): 22h-01h e 03h-07h nos dias uteis;
fim de semana inteiro fora do pico.

Escrita de cache entra pela tarifa de entrada sem cache — a DeepSeek nao publica
preco separado para ela.

## Como funciona

- **host** (`lib/index.js`): registra a projecao `sessionCost` em
  `ctx.sessionProjections`, com os precos vindos da configuracao. Amostra repetida
  do mesmo passo **substitui** a anterior em vez de somar (mesma regra do
  `dsh-token-meter`, senao cada passo contaria duas vezes).
- **cliente** (`lib/client.js`): registra uma linha no slot
  `conversation.composer.dock` e le a projecao com `useProjection('sessionCost')`.
  Se o slot nao existir nesta versao do harness, cai para
  `conversation.input.right` em vez de derrubar o boot.

## Instalar

```bash
./install.sh          # copia o pacote e escreve a entry na camada do usuario
cd .. && ./install-all.sh && ./doctor.sh
```

O `package.json` e o bundle do cliente so entram em vigor depois de **reiniciar o
`dsh web`** (o caminho do bundle fica em cache no processo). Depois disso, um F5
ja basta para mudar o `client.js`.

## Mudar preco ou janela de pico

Sem tocar em codigo: edite a entry em `$DSH_HOME/cordis.patch.yml`.

```yaml
- insert:
    - id: session-cost
      name: 'dsh-session-cost'
      config:
        modelo: deepseek-flash
        janelasDePico: ['01:00-04:00', '06:00-10:00']
        diasDePico: [1, 2, 3, 4, 5]
        picoCacheHit: 0.006
        picoCacheMiss: 0.30
        picoSaida: 1.20
        foraCacheHit: 0.003
        foraCacheMiss: 0.15
        foraSaida: 0.60
```

## Limites conhecidos

- Preco e do `deepseek-flash`. Usando outro modelo (por exemplo `deepseek-v4-pro`),
  ajuste os seis numeros na configuracao: a tabela nao adivinha o modelo.
- Sessoes antigas (de antes do plugin) aparecem com o custo do que estiver no log
  que o harness carregar — a projecao dobra o log da sessao aberta.
