/**
 * voice-input — metade cliente: botao de microfone no composer do DSH.
 *
 * Bundle no formato do module loader do harness (CJS em factory registrada em
 * window.__ModuleLoader__), requerido por id de modulo. Sem JSX/TypeScript: o
 * componente e escrito com React.createElement.
 *
 * Fluxo: clique -> getUserMedia + MediaRecorder (animacao com medidor de nivel
 * via AnalyserNode) -> clique de novo (ou parar) -> POST para
 * /voice-input/transcribe -> o texto volta e e anexado ao rascunho do composer
 * com inputActions.setDraft(). Esc cancela; clique direito descarta.
 */
window.__ModuleLoader__.load({
	id: 'dsh-voice-input',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');

		const ENDPOINT = '/voice-input/transcribe';
		const STYLE_ID = 'dsh-voice-input-styles';
		const SLOT = 'conversation.input.left';
		const inject = ['slots'];

		const CSS = [
			'.dsvi-btn{display:inline-flex;align-items:center;justify-content:center;gap:2px;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;opacity:.72;cursor:pointer;transition:opacity .15s ease,background .15s ease,border-color .15s ease}',
			'.dsvi-btn:hover:not(:disabled){opacity:1;background:rgba(127,127,127,.16)}',
			'.dsvi-btn:disabled{opacity:.4;cursor:default}',
			'.dsvi-btn.dsvi-rec{opacity:1;border-color:rgba(255,77,77,.55);background:rgba(255,77,77,.14);color:#ff5252;animation:dsvi-pulse 1.4s ease-in-out infinite}',
			'.dsvi-btn.dsvi-work{opacity:.9;cursor:progress}',
			'.dsvi-btn.dsvi-err{border-color:rgba(255,152,0,.65);color:#ff9800}',
			'.dsvi-bar{display:inline-block;width:2px;height:3px;border-radius:1px;background:currentColor}',
			'.dsvi-spin{display:inline-block;width:13px;height:13px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dsvi-spin .9s linear infinite}',
			'@keyframes dsvi-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,82,82,.55)}50%{box-shadow:0 0 0 5px rgba(255,82,82,0)}}',
			'@keyframes dsvi-spin{to{transform:rotate(360deg)}}',
		].join('\n');

		function installStyles() {
			if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return () => {};
			const element = document.createElement('style');
			element.id = STYLE_ID;
			element.textContent = CSS;
			document.head.appendChild(element);
			return () => {
				if (element.parentNode) element.parentNode.removeChild(element);
			};
		}

		const selectAll = (state) => state;

		function MicIcon() {
			return React.createElement(
				'svg',
				{
					width: 15,
					height: 15,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
				},
				React.createElement('rect', { key: 'capsule', x: 9, y: 3, width: 6, height: 11, rx: 3 }),
				React.createElement('path', { key: 'arc', d: 'M5 11a7 7 0 0 0 14 0' }),
				React.createElement('path', { key: 'stem', d: 'M12 18v3' }),
			);
		}

		function pickMimeType() {
			if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return '';
			const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
			for (const type of candidates) {
				try {
					if (window.MediaRecorder.isTypeSupported(type)) return type;
				} catch (error) {
					/* candidato invalido: segue */
				}
			}
			return '';
		}

		function MicButton(props) {
			const hookState = typeof props.useInput === 'function' ? props.useInput(selectAll) : null;
			const input = props.input || hookState || null;
			const draft = input && typeof input.draft === 'string' ? input.draft : '';
			const draftRef = React.useRef(draft);
			draftRef.current = draft;
			const actions = props.inputActions || null;
			const [mode, setMode] = React.useState('idle');
			const [note, setNote] = React.useState('');
			const modeRef = React.useRef('idle');
			const chunksRef = React.useRef([]);
			const recorderRef = React.useRef(null);
			const streamRef = React.useRef(null);
			const meterRef = React.useRef(null);
			const barsRef = React.useRef([]);
			const noteTimer = React.useRef(null);

			const setBoth = (next) => {
				modeRef.current = next;
				setMode(next);
			};

			const flash = (message) => {
				setNote(message);
				if (noteTimer.current) window.clearTimeout(noteTimer.current);
				noteTimer.current = window.setTimeout(() => setNote(''), 6000);
			};

			const releaseStream = () => {
				const stream = streamRef.current;
				streamRef.current = null;
				if (!stream) return;
				try {
					stream.getTracks().forEach((track) => track.stop());
				} catch (error) {
					/* stream ja encerrado */
				}
			};

			const stopMeter = () => {
				const meter = meterRef.current;
				meterRef.current = null;
				if (!meter) return;
				try {
					if (meter.raf) window.cancelAnimationFrame(meter.raf);
				} catch (error) {
					/* frame ja cancelado */
				}
				try {
					if (meter.actx && typeof meter.actx.close === 'function') meter.actx.close();
				} catch (error) {
					/* contexto ja fechado */
				}
			};

			const startMeter = (stream) => {
				try {
					const AudioCtor = window.AudioContext || window.webkitAudioContext;
					if (!AudioCtor) return;
					const actx = new AudioCtor();
					const source = actx.createMediaStreamSource(stream);
					const analyser = actx.createAnalyser();
					analyser.fftSize = 256;
					analyser.smoothingTimeConstant = 0.7;
					source.connect(analyser);
					const data = new Uint8Array(analyser.frequencyBinCount);
					const meter = { actx, analyser, data, raf: 0 };
					meterRef.current = meter;
					const bands = 4;
					const tick = () => {
						const live = meterRef.current;
						if (!live) return;
						live.analyser.getByteFrequencyData(live.data);
						const width = Math.floor(live.data.length / bands / 2);
						for (let index = 0; index < bands; index += 1) {
							const bar = barsRef.current[index];
							if (!bar) continue;
							let sum = 0;
							const from = index * width;
							const to = from + width;
							for (let cursor = from; cursor < to; cursor += 1) sum += live.data[cursor];
							const average = sum / Math.max(1, to - from);
							const height = Math.max(3, Math.min(13, 3 + (average / 255) * 10));
							bar.style.height = height.toFixed(1) + 'px';
						}
						live.raf = window.requestAnimationFrame(tick);
					};
					meter.raf = window.requestAnimationFrame(tick);
				} catch (error) {
					/* medidor e opcional: a gravacao segue sem ele */
				}
			};

			const finish = async (blob) => {
				setBoth('working');
				try {
					const response = await window.fetch(ENDPOINT, {
						method: 'POST',
						headers: { 'content-type': blob.type || 'application/octet-stream' },
						body: blob,
					});
					let data = null;
					try {
						data = await response.json();
					} catch (error) {
						data = null;
					}
					if (!response.ok || !data || data.ok === false) {
						throw new Error((data && data.error) || 'HTTP ' + response.status);
					}
					const text = String(data.text || '').trim();
					if (text === '') {
						flash('nada reconhecido');
						setBoth('idle');
						return;
					}
					const current = String(draftRef.current || '');
					const joiner = current === '' || /\s$/.test(current) ? '' : ' ';
					if (actions && typeof actions.setDraft === 'function') actions.setDraft(current + joiner + text);
					setNote('');
					setBoth('idle');
				} catch (error) {
					const message = String((error && error.message) || error);
					flash('transcricao falhou: ' + message);
					if (typeof console !== 'undefined') console.warn('[voice-input]', message);
					setBoth('idle');
				}
			};

			const start = async () => {
				if (!actions) {
					flash('composer indisponivel');
					return;
				}
				if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
					flash('microfone indisponivel neste contexto');
					return;
				}
				if (typeof window.MediaRecorder === 'undefined') {
					flash('MediaRecorder indisponivel');
					return;
				}
				setNote('');
				try {
					const stream = await navigator.mediaDevices.getUserMedia({
						audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
					});
					streamRef.current = stream;
					const mimeType = pickMimeType();
					const recorder = mimeType
						? new window.MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 })
						: new window.MediaRecorder(stream);
					chunksRef.current = [];
					recorder.ondataavailable = (event) => {
						if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
					};
					recorder.onerror = () => {
						flash('erro na gravacao');
					};
					recorder.onstop = () => {
						const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
						chunksRef.current = [];
						recorderRef.current = null;
						releaseStream();
						stopMeter();
						if (blob.size === 0) {
							setBoth('idle');
							flash('gravacao vazia');
							return;
						}
						void finish(blob);
					};
					recorderRef.current = recorder;
					recorder.start(1000);
					startMeter(stream);
					setBoth('recording');
				} catch (error) {
					const message = String((error && error.message) || error);
					const denied = message.indexOf('denied') !== -1 || message.indexOf('Permission') !== -1 || message.indexOf('NotAllowed') !== -1;
					flash(denied ? 'permissao de microfone negada' : 'falha ao gravar: ' + message);
					releaseStream();
					setBoth('idle');
				}
			};

			const stop = () => {
				const recorder = recorderRef.current;
				if (recorder && recorder.state !== 'inactive') recorder.stop();
			};

			const cancel = () => {
				const recorder = recorderRef.current;
				recorderRef.current = null;
				chunksRef.current = [];
				if (recorder) {
					recorder.onstop = null;
					if (recorder.state !== 'inactive') recorder.stop();
				}
				releaseStream();
				stopMeter();
				if (modeRef.current === 'recording') setBoth('idle');
			};

			const toggle = () => {
				if (modeRef.current === 'recording') stop();
				else if (modeRef.current === 'idle') void start();
			};

			React.useEffect(() => {
				if (mode !== 'recording') return undefined;
				const onKey = (event) => {
					if (event.key === 'Escape') cancel();
				};
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, [mode]);

			React.useEffect(
				() => () => {
					cancel();
					if (noteTimer.current) window.clearTimeout(noteTimer.current);
				},
				[],
			);

			const recording = mode === 'recording';
			const working = mode === 'working';
			const title = note
				? note
				: recording
					? 'Gravando... clique para transcrever (Esc cancela)'
					: working
						? 'Transcrevendo com Whisper local...'
						: 'Ditar em portugues (Whisper local)';
			const className = 'dsvi-btn' + (recording ? ' dsvi-rec' : '') + (working ? ' dsvi-work' : '') + (note ? ' dsvi-err' : '');
			const children = [];
			if (recording) {
				for (let index = 0; index < 4; index += 1) {
					children.push(
						React.createElement('span', {
							key: 'bar-' + index,
							className: 'dsvi-bar',
							ref: (element) => {
								barsRef.current[index] = element;
							},
						}),
					);
				}
			} else if (working) {
				children.push(React.createElement('span', { key: 'spin', className: 'dsvi-spin' }));
			} else {
				children.push(React.createElement(MicIcon, { key: 'icon' }));
			}

			return React.createElement(
				'button',
				{
					type: 'button',
					className,
					title,
					'aria-label': title,
					'data-dsh-voice-input': mode,
					onClick: toggle,
					onContextMenu: (event) => {
						if (modeRef.current !== 'recording') return;
						event.preventDefault();
						cancel();
					},
				},
				children,
			);
		}

		function apply(ctx) {
			ctx.effect(() => installStyles(), 'voice-input: estilos');
			ctx.slots.inject(SLOT, () =>
				ctx.slots.register(
					{
						name: SLOT,
						id: 'voice-input',
						order: 60,
						label: 'Ditar',
					},
					MicButton,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.MicButton = MicButton;
		return module.exports;
	},
});
