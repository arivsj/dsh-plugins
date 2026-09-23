/**
 * dsh-dev-rules — metade cliente.
 *
 * Desenha o cartao do plugin na tela de Configuracoes (secao Plugins, aba de
 * configuracao). O cartao e do plugin, nao do DSH: a aba so decide QUAIS chaves
 * despachar, e a chave e o namespace de settings que a metade host registra
 * (`dev-rules`). Sem esta metade, o namespace existiria e nao apareceria lugar
 * nenhum — o DSH nao interpreta namespace sozinho.
 *
 * As escolhas sao gravadas pelo proprio transporte de settings do DSH
 * (`settingsScope`), entao valem para qualquer perfil e ficam no arquivo de
 * settings do usuario, nao num arquivo paralelo.
 *
 * Bundle no formato do module loader do harness (CJS numa factory registrada em
 * window.__ModuleLoader__), sem JSX: React.createElement.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dev-rules',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    const NS = 'dev-rules';
    const ROTA = '/dev-rules/texto';

    const MIUDO = { opacity: 0.7, fontSize: '12px', lineHeight: '1.5' };

    /**
     * Le do host as regras em vigor e o texto que esta indo para o prompt.
     *
     * A lista vem do host, e nao do namespace, por um motivo: o TEXTO de cada
     * regra mora no catalogo (codigo ou config da entry) e o namespace guarda so
     * a escolha. O host e quem sabe juntar os dois.
     *
     * @returns promessa com `{ regras, texto }`.
     */
    async function lerDoHost() {
      const resposta = await fetch(ROTA, { headers: { accept: 'application/json' } });
      if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
      const dados = await resposta.json();
      return { regras: dados.regras ?? [], texto: dados.texto ?? '' };
    }

    /**
     * O cartao: uma caixa por regra, e o texto final a mostra.
     *
     * @param props - `escopo` (settingsScope ligado a este namespace).
     * @returns o cartao.
     */
/**
     * Junta uma regra nova a lista que o dev ja escreveu.
     *
     * Pura de proposito: e a unica parte do 'acrescentar' que da para provar sem
     * navegador, e e onde mora a regra que importa — texto vazio nao entra, e a
     * lista velha nunca e mutada (o namespace compara e publica o que mudou).
     *
     * @param minhas a lista atual (pode vir ausente).
     * @param texto o que o dev escreveu.
     * @returns a lista nova, ou a mesma quando nao ha o que acrescentar.
     */
    function montarMinhas(minhas, texto) {
      const limpo = String(texto ?? '').trim();
      if (limpo.length === 0) return minhas ?? [];
      const id = 'minha-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      return [...(minhas ?? []), { id, texto: limpo, ligada: true }];
    }

    function CartaoDeRegras(props) {
      const escopo = props.escopo;
      const [regras, setRegras] = React.useState([]);
      const [nova, setNova] = React.useState('');
      const [texto, setTexto] = React.useState('');
      const [erro, setErro] = React.useState(null);
      const [ocupado, setOcupado] = React.useState(false);

      const recarregar = React.useCallback(async () => {
        try {
          const lido = await lerDoHost();
          setRegras(lido.regras);
          setTexto(lido.texto);
          setErro(null);
        } catch (falha) {
          setErro(String(falha && falha.message ? falha.message : falha));
        }
      }, []);

      React.useEffect(() => {
        recarregar();
      }, [recarregar]);

      // A escolha mudou (aqui ou em outra aba): a lista em vigor muda junto.
      React.useEffect(() => escopo.subscribe(() => { recarregar(); }), [escopo, recarregar]);

      /**
       * Liga ou desliga uma regra, gravando os dois deltas da escolha.
       *
       * Grava os DOIS arrays porque `settingsScope.set` escreve um campo por vez e
       * a escolha e o par (ligadas, desligadas): deixar o outro campo velho faria
       * a regra voltar ao estado anterior na proxima leitura.
       *
       * @param regra - a regra tocada.
       */
      async function alternar(regra) {
        if (ocupado) return;
        setOcupado(true);
        try {
          const escolha = escopo.getSnapshot().value ?? {};
          // Regra escrita na tela carrega o proprio `ligada`: ela nao e
          // catalogo, entao nao entra nos deltas (que existem para o
          // catalogo nao perder a fabrica quando o dev mexe numa regra so).
          if (regra.origem === 'minha') {
            const minhas = (escolha.minhas ?? []).map((item) =>
              item.id === regra.id ? { ...item, ligada: !regra.ligada } : item,
            );
            await escopo.set('minhas', minhas);
          } else {
            const ligadas = new Set(escolha.ligadas ?? []);
            const desligadas = new Set(escolha.desligadas ?? []);
            if (regra.ligada) {
              desligadas.add(regra.id);
              ligadas.delete(regra.id);
            } else {
              ligadas.add(regra.id);
              desligadas.delete(regra.id);
            }
            await escopo.set('ligadas', [...ligadas]);
            await escopo.set('desligadas', [...desligadas]);
          }
          await recarregar();
        } catch (falha) {
          setErro(String(falha && falha.message ? falha.message : falha));
        } finally {
          setOcupado(false);
        }
      }

      /**
       * Acrescenta a regra escrita no campo.
       *
       * Grava a lista inteira no namespace: a partir daqui ela vale para o
       * prompt no passo seguinte, sem editar config nem reiniciar nada.
       */
      async function acrescentar() {
        if (ocupado || nova.trim().length === 0) return;
        setOcupado(true);
        try {
          const escolha = escopo.getSnapshot().value ?? {};
          await escopo.set('minhas', montarMinhas(escolha.minhas, nova));
          setNova('');
          await recarregar();
        } catch (falha) {
          setErro(String(falha && falha.message ? falha.message : falha));
        } finally {
          setOcupado(false);
        }
      }

      /**
       * Tira uma regra que o dev escreveu.
       *
       * @param regra a regra a remover.
       */
      async function remover(regra) {
        if (ocupado) return;
        setOcupado(true);
        try {
          const escolha = escopo.getSnapshot().value ?? {};
          await escopo.set('minhas', (escolha.minhas ?? []).filter((item) => item.id !== regra.id));
          await recarregar();
        } catch (falha) {
          setErro(String(falha && falha.message ? falha.message : falha));
        } finally {
          setOcupado(false);
        }
      }

      const podeEscrever = escopo.getSnapshot().writable !== false;

      const itens = regras.map((regra) => React.createElement(
        'li',
        { key: regra.id, style: { margin: '0 0 10px 0' } },
        React.createElement(
          'label',
          { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: podeEscrever ? 'pointer' : 'default' } },
          React.createElement('input', {
            type: 'checkbox',
            checked: Boolean(regra.ligada),
            disabled: !podeEscrever || ocupado,
            onChange: () => { alternar(regra); },
            style: { marginTop: '2px' },
          }),
          React.createElement('span', { style: { flex: 1 } }, regra.texto),
          regra.origem === 'minha'
            ? React.createElement('button', {
                type: 'button',
                disabled: !podeEscrever || ocupado,
                onClick: () => { remover(regra); },
                title: 'remover esta regra',
                style: { background: 'transparent', border: 'none', color: 'inherit', opacity: 0.55, cursor: 'pointer' },
              }, '\u2715')
            : null,
        ),
      ));

      const filhos = [
        // O cartao e inteiro do plugin: a aba so despacha a chave, entao o nome
        // do plugin e a explicacao de onde o texto entra sao meus, nao do DSH.
        React.createElement('h3', { key: 'nome', style: { margin: '0 0 4px 0', fontSize: '14px' } }, 'Regras do dev'),
        React.createElement(
          'p',
          { key: 'intro', style: MIUDO },
          'Estas regras vao no prompt inicial de toda sessao, numa secao so do plugin. Desmarque o que nao vale.',
        ),
        regras.length > 0
          ? React.createElement('ul', { key: 'lista', style: { listStyle: 'none', padding: 0, margin: '0 0 10px 0' } }, itens)
          : React.createElement('p', { key: 'vazio', style: MIUDO }, 'Nenhuma regra no catalogo.'),
        React.createElement('div', { key: 'nova', style: { display: 'flex', gap: '8px', margin: '0 0 12px 0' } },
          React.createElement('input', {
            type: 'text',
            value: nova,
            disabled: !podeEscrever || ocupado,
            placeholder: 'escreva uma regra nova e acrescente',
            onChange: (evento) => { setNova(evento.target.value); },
            onKeyDown: (evento) => { if (evento.key === 'Enter') acrescentar(); },
            style: { flex: 1, padding: '6px 8px', borderRadius: '8px', border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit' },
          }),
          React.createElement('button', {
            type: 'button',
            disabled: !podeEscrever || ocupado || nova.trim().length === 0,
            onClick: () => { acrescentar(); },
            style: { padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(127,127,127,.45)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
          }, 'acrescentar'),
        ),
        React.createElement('details', { key: 'texto' }, [
          React.createElement('summary', { key: 'titulo', style: { cursor: 'pointer' } }, 'O texto que esta indo para o prompt'),
          React.createElement(
            'pre',
            {
              key: 'corpo',
              style: {
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: '8px 0 0 0',
                padding: '10px',
                border: '1px solid rgba(127,127,127,.35)',
                borderRadius: '8px',
                ...MIUDO,
              },
            },
            texto || '(nenhuma regra ligada: o prompt segue sem esta secao)',
          ),
        ]),
      ];
      if (!podeEscrever) {
        filhos.splice(1, 0, React.createElement('p', { key: 'travado', style: MIUDO }, 'Este deployment guarda settings so de leitura.'));
      }
      if (erro) {
        filhos.push(React.createElement('p', { key: 'erro', style: { ...MIUDO, color: '#ff5252' } }, 'Nao deu para ler o texto do prompt: ' + erro));
      }
      return React.createElement('div', null, filhos);
    }

    /**
     * Monta a metade cliente.
     *
     * @param ctx contexto do cliente (cordis).
     */
    function apply(ctx) {
      const escopo = ctx.settingsScope.bind({ namespace: NS });
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
        { name: 'settings.plugin.item', key: NS, inject: () => ({ escopo }) },
        CartaoDeRegras,
      ));
    }

    exports.apply = apply;
    exports.montarMinhas = montarMinhas;
    exports.inject = ['slots', 'settingsScope', 'connection', 'remote'];
    return module.exports;
  },
});
