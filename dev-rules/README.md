# dsh-dev-rules

Põe as **regras do dev no prompt inicial do Harness** — e deixa escolher quais
valem na tela de **Configurações › Plugins**, em vez de repetir as mesmas frases
em toda conversa.

```
Configurações › Plugins › Plugins › Configuração de plugins
  ▸ Regras do dev
      ☑ Todo .md que existe só por causa do meu contexto de desenvolvimento …
      ☑ Nunca faça commit nem push sem me perguntar antes …
      ☐ Quando eu fizer uma pergunta, responda antes de começar a escrever código.
      [ escreva uma regra nova e acrescente ]  [ acrescentar ]
      ▸ O texto que está indo para o prompt
```

## Como o texto entra no prompt

O plugin registra **uma seção** no serviço `systemPrompt` do DSH:

```js
ctx.systemPrompt.section({
  name: 'dev:regras',
  order: 10,                       // logo depois da persona (0)
  text: () => textoDoPrompt(...),  // FUNÇÃO: remontada a cada passo do modelo
})
```

A seção é aditiva: nada do que o Harness já manda muda. Ela é **dinâmica** — o
texto é remontado a cada passo —, então ligar ou desligar uma regra na tela vale
do passo seguinte em diante, sem reiniciar nada. E, com todas desligadas, o texto
é vazio e a seção não entra no prompt: o prompt volta a ser exatamente o original.

## O que é catálogo e o que é escolha

| peça | onde vive | quem mexe |
|---|---|---|
| **catálogo** (id + texto das regras) | código (`REGRAS_DE_FABRICA`) ou config da entry, no `cordis.patch.yml` | você, editando |
| **escolha** (quais valem) | namespace de settings `dev-rules`, no arquivo de settings do DSH | a tela de Configurações |
| **as suas regras** (escritas na tela) | o mesmo namespace, campo `minhas` | você, pelo campo do cartão |

A escolha guarda **deltas**, não a lista inteira: `{ ligadas: [...], desligadas: [...] }`.
Regra que não aparece em nenhum dos dois segue o estado de fábrica do catálogo — e
por isso uma regra **nova**, acrescentada depois, nasce valendo em vez de nascer
desligada por não estar numa lista velha.

### Acrescentar ou reescrever uma regra (pela config)

```yaml
- insert:
    - id: dev-rules
      name: 'dsh-dev-rules'
      config:
        ordem: 10
        cabecalho: 'Regras da casa:'
        regras:
          - id: md-privado
            ligada: true
            texto: 'Todo .md que existe só por causa do meu contexto...'
          - id: nova-regra
            ligada: true
            texto: 'Sempre me diga o que vai fazer antes de fazer.'
```

## As três regras que vêm de fábrica

1. Todo `.md` que existe só por causa do contexto de desenvolvimento (notas de
   passagem, pendências, estado, diagnóstico da máquina) **não vai para o GitHub**
   — a não ser que o dev peça explicitamente.
2. **Nunca** fazer commit nem push sem perguntar antes — mas a autorização pode
   ser de um commit, de **vários de uma vez**, ou de um **"suba tudo"**: depois de
   muita troca, ele manda fechar a rodada inteira (um commit por repositório/
   assunto), sem perguntar de novo, listando no fim o que foi para onde.
3. Quando o dev fizer uma pergunta, **responder antes** de começar a escrever código.

## Rota de leitura

`GET /dev-rules/texto` devolve `{ regras, escolhas, texto }` — o que está em vigor
e exatamente o texto que está indo para o prompt. É o que o cartão mostra e o que
permite conferir de fora:

```bash
curl -s http://127.0.0.1:3080/dev-rules/texto | python3 -m json.tool
```

## Instalar

```bash
./install.sh            # copia o pacote e escreve a entry na camada do usuario
cd .. && ./install-all.sh && ./doctor.sh
```

Depois, **F5** na página do Harness. O `package.json` (nome, `exports`, `dsh.client`)
só entra em vigor reiniciando o `dsh web`; depois disso, F5 basta. As mudanças de
`lib/client.js` e `lib/index.js` são aplicadas a quente.

## Provas

```bash
node .dev/host-test.mjs      # 32 provas: a secao, a escolha, a rota, as regras do dev
node .dev/client-test.mjs    # 15 provas: o cartao no slot certo, com a chave certa, e a regra nova
```

## Limites conhecidos

- **A tela não EDITA** uma regra: ela liga, desliga, acrescenta e remove. Corrigir o texto
  de uma regra do catálogo é editar o código ou o `cordis.patch.yml`; a regra que você
  escreveu na tela se corrige removendo e escrevendo de novo.
- **A lista das suas regras é a ordem de leitura**: elas entram DEPOIS do catálogo, na
  ordem em que foram acrescentadas.
- **Regra nova no CATÁLOGO ainda é pela config** (acima): o catálogo é a fábrica, e
  mudá-lo vale para todo mundo que usar o plugin. O que a tela acrescenta são as SUAS
  regras, no campo `minhas` do namespace.
- O `id` da entry, o `id` do bundle e o namespace de settings são **o mesmo nome**
  (`dev-rules`) de propósito: é a chave que faz o DSH despachar o cartão. Trocar um
  sem os outros faz o cartão sumir sem erro no log.
- Perfil sem `settings` (ou sem `systemPrompt`) não registra nada e não derruba o
  boot: os dois serviços entram por `ctx.inject`.
