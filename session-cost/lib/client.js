/**
 * session-cost — metade cliente: o valor gasto, no rodape do composer.
 *
 * Bundle no formato do module loader do harness (CJS numa factory registrada em
 * window.__ModuleLoader__), sem JSX: o componente e escrito com
 * React.createElement. So DESENHA: a conta (com preco por horario) vem pronta
 * na projecao `sessionCost`, publicada pela metade host.
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
		const inject = ['slots'];

		const CSS = [
			'.dshc-root{display:flex;align-items:center;gap:6px;padding:2px 10px 6px;font-size:11px;line-height:1.3;opacity:.72;font-variant-numeric:tabular-nums;user-select:text}',
			'.dshc-root:hover{opacity:1}',
			'.dshc-usd{font-weight:600}',
			'.dshc-sep{opacity:.45}',
			'.dshc-dim{opacity:.8}',
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
		 * Escreve dolar como se le dinheiro: virgula decimal e casas suficientes
		 * para o valor nao virar zero na tela (a sessao de teste custou menos de um
		 * centavo, e zero seria mentira).
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
		 * A linha: valor, entrada e saida. Nada de tabela — e um rodape.
		 * @param props - kit do slot (traz useProjection).
		 * @returns elemento ou null quando ainda nao ha amostra.
		 */
		function LinhaDeCusto(props) {
			const useProjection = props && props.useProjection;
			if (typeof useProjection !== 'function') return null;
			const custo = useProjection('sessionCost');
			if (!custo || !custo.amostras) return null;

			const entrada = (custo.semCache || 0) + (custo.doCache || 0) + (custo.escrita || 0);
			const cache = entrada > 0 ? Math.round(((custo.doCache || 0) / entrada) * 100) : 0;
			const dica = [
				'modelo ' + (custo.modelo || 'deepseek-flash'),
				'no pico: ' + emDolar(custo.usdPico || 0),
				'fora do pico: ' + emDolar((custo.usd || 0) - (custo.usdPico || 0)),
				'entrada ' + compacto(entrada) + ' (cache ' + cache + '%)',
				'saida ' + compacto(custo.saida || 0),
			].join(' · ');

			const partes = [
				React.createElement('span', { key: 'usd', className: 'dshc-usd' }, emDolar(custo.usd)),
				React.createElement('span', { key: 's1', className: 'dshc-sep' }, '·'),
				React.createElement('span', { key: 'in', className: 'dshc-dim' },
					compacto(entrada) + ' entrada' + (cache > 0 ? ' (' + cache + '% cache)' : '')),
				React.createElement('span', { key: 's2', className: 'dshc-sep' }, '·'),
				React.createElement('span', { key: 'out', className: 'dshc-dim' }, compacto(custo.saida) + ' saida'),
			]

			return React.createElement(
				'div',
				{ className: 'dshc-root', title: dica, 'data-dsh-session-cost': 'on' },
				partes,
			)
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
		exports.emDolar = emDolar;
		exports.compacto = compacto;
		return module.exports;
	},
});
