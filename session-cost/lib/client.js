/**
 * session-cost — metade cliente: o valor gasto no rodape, e a janelinha de precos.
 *
 * O VALOR E CLICAVEL de proposito. Este plugin nao sabe o preco de nada: ele usa
 * uma tabela que o USUARIO mantem. Clicar abre a janelinha, onde se escreve o
 * modelo e se pede para buscar a tabela oficial na internet — o host busca, le e
 * guarda, e o proximo passo ja e contado com o preco novo.
 *
 * Bundle no formato do module loader do harness (CJS numa factory registrada em
 * window.__ModuleLoader__), sem JSX: React.createElement e CSS proprio.
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-cost',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');

		const PRINCIPAL = 'conversation.composer.dock';
		const RESERVA = 'conversation.input.right';
		const STYLE_ID = 'dsh-session-cost-styles';
		const ROTA = '/session-cost/precos';
		const inject = ['slots'];

		const CSS = [
			'.dshc-root{display:flex;align-items:center;gap:6px;padding:2px 10px 6px;font-size:11px;line-height:1.3;font-variant-numeric:tabular-nums}',
			'.dshc-btn{display:flex;align-items:center;gap:6px;padding:2px 6px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.72;text-align:left}',
			'.dshc-btn:hover{opacity:1;background:rgba(127,127,127,.14);border-color:rgba(127,127,127,.25)}',
			'.dshc-usd{font-weight:600}',
			'.dshc-sep{opacity:.45}',
			'.dshc-dim{opacity:.8}',
			'.dshc-aviso{color:#ff9800}',
			'.dshc-fundo{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:60}',
			'.dshc-card{width:min(460px,92vw);background:#1b1b22;color:#e8e8ef;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.5)}',
			'.dshc-card h2{margin:0;font-size:14px;font-weight:600}',
			'.dshc-card p{margin:0;font-size:12px;line-height:1.5;opacity:.8}',
			'.dshc-linha{display:flex;gap:8px;align-items:center}',
			'.dshc-input{flex:1;padding:7px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:inherit;font:inherit}',
			'.dshc-acao{padding:7px 12px;border-radius:8px;border:1px solid rgba(127,127,255,.5);background:rgba(127,127,255,.18);color:inherit;font:inherit;cursor:pointer}',
			'.dshc-acao:disabled{opacity:.5;cursor:default}',
			'.dshc-tabela{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}',
			'.dshc-tabela th,.dshc-tabela td{text-align:right;padding:3px 4px;border-bottom:1px solid rgba(255,255,255,.08)}',
			'.dshc-tabela th:first-child,.dshc-tabela td:first-child{text-align:left;opacity:.75}',
			'.dshc-ok{color:#4caf50}',
			'.dshc-erro{color:#ff5252}',
			'.dshc-fechar{align-self:flex-end;background:transparent;border:none;color:inherit;opacity:.6;cursor:pointer;font:inherit}',
		].join('\n');

		/**
		 * Instala o CSS uma vez; devolve o removedor para o efeito do cordis.
		 * @returns funcao que remove a folha.
		 */
		function installStyles() {
			if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return () => {};
			const folha = document.createElement('style');
			folha.id = STYLE_ID;
			folha.textContent = CSS;
			document.head.appendChild(folha);
			return () => {
				if (folha.parentNode) folha.parentNode.removeChild(folha);
			};
		}

		/**
		 * Escreve dolar como se le dinheiro.
		 * @param valor - valor em US$.
		 * @returns texto curto.
		 */
		function emDolar(valor) {
			if (!Number.isFinite(valor) || valor <= 0) return 'US$ 0';
			const casas = valor < 0.01 ? 4 : valor < 1 ? 3 : 2;
			return 'US$ ' + valor.toFixed(casas).replace('.', ',');
		}

		/**
		 * Numero de tokens em forma curta (1,2k / 3,4M).
		 * @param valor - quantidade de tokens.
		 * @returns texto curto.
		 */
		function compacto(valor) {
			const n = Number(valor) || 0;
			if (n < 1000) return String(n);
			if (n < 1e6) return (Math.round(n / 100) / 10).toString().replace('.', ',') + 'k';
			return (Math.round(n / 1e5) / 10).toString().replace('.', ',') + 'M';
		}

		/**
		 * Data curta para "atualizado em".
		 * @param ms - instante em ms.
		 * @returns texto, ou vazio.
		 */
		function quando(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return '';
			const d = new Date(ms);
			const p = (n) => String(n).padStart(2, '0');
			return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
		}

		/**
		 * A janelinha: o modelo, a tabela em vigor e o botao que busca na internet.
		 * @param props - custo (projecao) e onFechar.
		 * @returns o overlay.
		 */
		function Janelinha(props) {
			const custo = props.custo;
			const sugerido = custo.modeloSessao || custo.modelo || 'deepseek-flash';
			const [modelo, setModelo] = React.useState(sugerido);
			const [estado, setEstado] = React.useState({ ocupado: false, ok: null, erro: null, precos: null, atualizadoEm: 0, modelo: null });

			const atualizar = async () => {
				setEstado({ ocupado: true, ok: null, erro: null, precos: null, atualizadoEm: 0, modelo: null });
				try {
					const resposta = await fetch(ROTA, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ model: modelo }),
					});
					const dados = await resposta.json();
					if (dados.ok) {
						setEstado({ ocupado: false, ok: true, erro: null, precos: dados.precos, atualizadoEm: dados.atualizadoEm, modelo: dados.modelo });
					} else {
						setEstado({ ocupado: false, ok: false, erro: dados.erro || ('HTTP ' + resposta.status), precos: null, atualizadoEm: 0, modelo: null });
					}
				} catch (erro) {
					setEstado({ ocupado: false, ok: false, erro: String(erro && erro.message ? erro.message : erro), precos: null, atualizadoEm: 0, modelo: null });
				}
			};

			const precos = estado.precos || null;
			const linhas = [
				['entrada (cache hit)', 'CacheHit'],
				['entrada (cache miss)', 'CacheMiss'],
				['saida', 'Saida'],
			];

			return React.createElement(
				'div',
				{ className: 'dshc-fundo', onClick: props.onFechar },
				React.createElement(
					'div',
					{ className: 'dshc-card', onClick: (evento) => evento.stopPropagation() },
					React.createElement('h2', null, 'Preco da sessao'),
					React.createElement(
						'p',
						null,
						'Este plugin nao sabe o preco de nada: a tabela e escrita por VOCE. ',
						'Ela comeca com os valores de fabrica e passa a valer o que voce buscar aqui — ',
						'guardado em ~/.dsh/session-cost/precos.json.',
					),
					props.divergente
						? React.createElement(
							'p',
							{ className: 'dshc-aviso' },
							'A sessao esta em "' + custo.modeloSessao + '" e estes precos sao de "' + custo.modelo + '". Atualize para o modelo certo.',
						  )
						: null,
					React.createElement(
						'div',
						{ className: 'dshc-linha' },
						React.createElement('input', {
							className: 'dshc-input',
							value: modelo,
							onChange: (evento) => setModelo(evento.target.value),
							placeholder: 'modelo que voce esta usando (ex.: deepseek-flash)',
							'aria-label': 'modelo',
						}),
						React.createElement(
							'button',
							{ className: 'dshc-acao', onClick: atualizar, disabled: estado.ocupado || !modelo.trim() },
							estado.ocupado ? 'buscando...' : 'Atualizar preco',
						),
					),
					precos
						? React.createElement(
							'p',
							{ className: 'dshc-ok' },
							'Precos de "' + estado.modelo + '" atualizados ' + quando(estado.atualizadoEm) + '. Ja valem para o proximo passo.',
						  )
						: null,
					estado.erro ? React.createElement('p', { className: 'dshc-erro' }, 'Nao deu: ' + estado.erro) : null,
					React.createElement(
						'table',
						{ className: 'dshc-tabela' },
						React.createElement(
							'thead',
							null,
							React.createElement(
								'tr',
								null,
								React.createElement('th', null, 'por 1M de tokens'),
								React.createElement('th', null, 'pico'),
								React.createElement('th', null, 'fora do pico'),
							),
						),
						React.createElement(
							'tbody',
							null,
							linhas.map(([rotulo, campo]) =>
								React.createElement(
									'tr',
									{ key: campo },
									React.createElement('td', null, rotulo),
									React.createElement('td', null, precos ? '$' + precos['pico' + campo] : '-'),
									React.createElement('td', null, precos ? '$' + precos['fora' + campo] : '-'),
								),
							),
						),
					),
					React.createElement(
						'p',
						null,
						precos
							? 'A busca le a pagina oficial da DeepSeek (api-docs.deepseek.com) e reescreve o arquivo.'
							: 'Em vigor agora: ' + (custo.modelo || 'sem modelo') + ' (' + (custo.origem === 'usuario' ? 'atualizado por voce ' + quando(custo.atualizadoEm) : 'valores de fabrica') + ').',
					),
					React.createElement('button', { className: 'dshc-fechar', onClick: props.onFechar }, 'fechar'),
				),
			);
		}

		/**
		 * A linha do rodape: clicavel, abre a janelinha.
		 * @param props - kit do slot (traz useProjection).
		 * @returns elemento ou null quando ainda nao ha amostra.
		 */
		function LinhaDeCusto(props) {
			const useProjection = props && props.useProjection;
			const [aberto, setAberto] = React.useState(false);
			const custo = typeof useProjection === 'function' ? useProjection('sessionCost') : undefined;
			if (!custo || !custo.amostras) return null;

			const entrada = (custo.semCache || 0) + (custo.doCache || 0) + (custo.escrita || 0);
			const cache = entrada > 0 ? Math.round(((custo.doCache || 0) / entrada) * 100) : 0;
			const divergente = Boolean(custo.modeloSessao && custo.modelo && custo.modeloSessao !== custo.modelo);

			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					'div',
					{ className: 'dshc-root' },
					React.createElement(
						'button',
						{
							className: 'dshc-btn',
							title: 'Clique para ver e atualizar a tabela de precos (ela e escrita por voce)',
							'data-dsh-session-cost': 'on',
							onClick: () => setAberto(true),
						},
						React.createElement('span', { className: 'dshc-usd' }, emDolar(custo.usd)),
						React.createElement('span', { className: 'dshc-sep' }, '·'),
						React.createElement('span', { className: 'dshc-dim' },
							compacto(entrada) + ' entrada' + (cache > 0 ? ' (' + cache + '% cache)' : '')),
						React.createElement('span', { className: 'dshc-sep' }, '·'),
						React.createElement('span', { className: 'dshc-dim' }, compacto(custo.saida) + ' saida'),
						divergente
							? React.createElement('span', { className: 'dshc-aviso' }, '· preco de ' + custo.modelo)
							: null,
					),
				),
				aberto
					? React.createElement(Janelinha, { custo: custo, divergente: divergente, onFechar: () => setAberto(false) })
					: null,
			);
		}

		/**
		 * Registra a linha no slot. Se o slot do rodape nao existir nesta versao do
		 * harness, cai para a barra do composer em vez de derrubar o boot.
		 * @param ctx - contexto do cliente.
		 */
		function apply(ctx) {
			ctx.effect(() => installStyles(), 'session-cost: estilos');
			const registrarEm = (slot) => ctx.slots.register(
				{ name: slot, id: 'session-cost', order: 70 },
				LinhaDeCusto,
			)
			ctx.slots.inject(PRINCIPAL, () => {
				try {
					return registrarEm(PRINCIPAL)
				} catch (erro) {
					return ctx.slots.inject(RESERVA, () => registrarEm(RESERVA))
				}
			})
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.LinhaDeCusto = LinhaDeCusto;
		exports.Janelinha = Janelinha;
		exports.emDolar = emDolar;
		exports.compacto = compacto;
		return module.exports;
	},
});
