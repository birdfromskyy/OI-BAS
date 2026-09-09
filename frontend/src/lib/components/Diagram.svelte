<script module lang="ts">
	export type Slice = {
		label: string;
		value: number;
		/** Вторая величина той же доли: у полётов это налёт в секундах */
		extra?: number;
		color?: string;
	};
</script>

<script lang="ts">
	/**
	 * Круговая диаграмма (ФТ-15.4, ФТ-15.5): доля полётов по бортам и по пилотам.
	 * В центре — общее количество, снизу легенда со значениями и долями.
	 *
	 * По ФТ-15.4 при числе категорий свыше восьми диаграмма заменяется
	 * горизонтальной гистограммой — на кольце столько долей уже не различить.
	 */
	let {
		data = [],
		title = '',
		caption = 'всего',
		extraCaption = '',
		formatExtra = (n: number) => String(n),
		maxSlices = 6,
		barsAbove = 8,
		onselect,
		onover
	}: {
		data?: Slice[];
		title?: string;
		/** подпись под числом в центре */
		caption?: string;
		/**
		 * Подпись второй величины. Задана и у долей есть `extra` — над диаграммой
		 * появляется переключатель: одни и те же доли, но по другой мерке.
		 * Число вылетов и налёт дают разные картины, и выбирать за пользователя,
		 * какая из них «настоящая», неправильно (ФТ-15.7).
		 */
		extraCaption?: string;
		/** как печатать вторую величину: налёт — часами, а не секундами */
		formatExtra?: (n: number) => string;
		/** сколько долей показывать отдельно; остальные сворачиваются в «Прочие» */
		maxSlices?: number;
		/** свыше скольких категорий переключаться на гистограмму (ФТ-15.4) */
		barsAbove?: number;
		onselect?: (s: Slice) => void;
		/**
		 * Курсор над долей: наружу уходят названия категорий, которые она
		 * покрывает, — панель подсвечивает их полёты на карте и в календаре.
		 * У «Прочих» таких названий несколько, поэтому список, а не строка.
		 * null — курсор ушёл с диаграммы.
		 */
		onover?: (labels: string[] | null) => void;
	} = $props();

	/** По какой величине строится кольцо: основной или второй */
	let byExtra = $state(false);
	const hasExtra = $derived(extraCaption !== '' && data.some((s) => (s.extra ?? 0) > 0));
	const measure = (s: Slice) => (byExtra ? (s.extra ?? 0) : s.value);

	/**
	 * Категориальная палитра: восемь оттенков в фиксированном порядке.
	 * Порядок — механизм различимости при дальтонизме, а не украшение:
	 * набор проверен на панели #161C2C (ΔE протанопия 8.4, обычное зрение 19.3,
	 * контраст к фону ≥ 3:1). Менять порядок или подставлять свои цвета
	 * можно только заново прогнав валидатор.
	 * Переопределяются токенами --color-series-1…8, если добавите их в @theme.
	 */
	const SERIES = [
		'var(--color-series-1, #3987e5)',
		'var(--color-series-2, #d95926)',
		'var(--color-series-3, #199e70)',
		'var(--color-series-4, #c98500)',
		'var(--color-series-5, #d55181)',
		'var(--color-series-6, #008300)',
		'var(--color-series-7, #9085e9)',
		'var(--color-series-8, #e66767)'
	];
	const OTHER = 'var(--color-text-muted)';

	const sorted = $derived(
		[...data].filter((s) => measure(s) > 0).sort((a, b) => measure(b) - measure(a))
	);

	/**
	 * Хвост сворачивается в «Прочие» — девятый цвет не выдумывается.
	 * Рядом с долей едет список категорий, которые она покрывает: у обычной
	 * это она сама, у «Прочих» — весь свёрнутый хвост. По нему панель и находит
	 * полёты, которые нужно подсветить.
	 */
	const slices = $derived.by((): (Slice & { color: string; labels: string[] })[] => {
		if (sorted.length <= maxSlices) {
			return sorted.map((s, i) => ({ ...s, color: s.color ?? SERIES[i], labels: [s.label] }));
		}
		const head = sorted.slice(0, maxSlices - 1);
		const tail = sorted.slice(maxSlices - 1);
		return [
			...head.map((s, i) => ({ ...s, color: s.color ?? SERIES[i], labels: [s.label] })),
			{
				label: 'Прочие',
				value: tail.reduce((n, s) => n + s.value, 0),
				extra: tail.reduce((n, s) => n + (s.extra ?? 0), 0),
				color: OTHER,
				labels: tail.map((s) => s.label)
			}
		];
	});

	const total = $derived(sorted.reduce((n, s) => n + measure(s), 0));
	/** Итог второй величины показывается подписью рядом с центром */
	const totalOther = $derived(sorted.reduce((n, s) => n + (byExtra ? s.value : (s.extra ?? 0)), 0));
	const asBars = $derived(sorted.length > barsAbove);

	// геометрия кольца
	const R = 64;
	const C = 2 * Math.PI * R;
	const GAP = 2; // разделяет доли фоном, а не обводкой

	const arcs = $derived.by(() => {
		let acc = 0;
		return slices.map((s) => {
			const frac = total > 0 ? measure(s) / total : 0;
			const start = acc * C;
			acc += frac;
			return { ...s, frac, len: Math.max(frac * C - GAP, 0.5), start };
		});
	});

	let hovered: number | null = $state(null);
	/** Гистограмма живёт своим списком: у неё долей нет, есть строки */
	let hoveredBar: string | null = $state(null);

	// что под курсором — то и подсвечивается на остальной панели
	$effect(() => {
		if (hoveredBar !== null) return onover?.([hoveredBar]);
		onover?.(hovered === null ? null : (arcs[hovered]?.labels ?? null));
	});

	const nf = new Intl.NumberFormat('ru-RU');
	const pf = (f: number) => `${(f * 100).toFixed(f < 0.01 ? 1 : 0)}%`;

	/** В центре — общее число, при наведении — значение выбранной доли. */
	const centerValue = $derived(
		hovered === null ? total : measure(arcs[hovered] ?? { label: '', value: total })
	);
	const centerCaption = $derived(hovered === null ? caption : (arcs[hovered]?.label ?? caption));
	const maxBar = $derived(Math.max(1, ...sorted.map((s) => measure(s))));

	/** Печать величины: основная — числом, вторая — своим форматом */
	const show = (n: number, extra = byExtra) => (extra ? formatExtra(n) : nf.format(n));

	/** Строка доли для подсказки: обе величины и средняя длительность вылета */
	function hint(s: Slice): string {
		const parts = [`${nf.format(s.value)} · ${caption}`];
		if (extraCaption && s.extra !== undefined) {
			parts.push(`${formatExtra(s.extra)} · ${extraCaption}`);
			if (s.value > 0) parts.push(`в среднем ${formatExtra(Math.round(s.extra / s.value))}`);
		}
		return `${s.label}: ${parts.join(', ')}`;
	}
</script>

<section class="flex flex-col gap-4 rounded-lg border bg-front p-4">
	<header class="flex flex-wrap items-center justify-between gap-3">
		{#if title}
			<h2 class="text-2xl">{title}</h2>
		{/if}

		{#if hasExtra}
			<!-- одни и те же доли по двум меркам: борт может летать чаще всех
			     короткими подлётами, а часы набирать другой -->
			<div class="flex items-center gap-1 text-sm">
				{#each [{ on: false, text: caption }, { on: true, text: extraCaption }] as tab (tab.text)}
					<button
						type="button"
						class={[
							'click min-h-0 cursor-pointer rounded-sm px-2 py-1',
							byExtra === tab.on ? 'bg-accent/15 text-accent' : 'text-text-muted'
						]}
						aria-pressed={byExtra === tab.on}
						onclick={() => (byExtra = tab.on)}
					>
						{tab.text}
					</button>
				{/each}
			</div>
		{/if}
	</header>

	{#if total === 0}
		<p class="py-8 text-center text-sm text-text-muted">Нет данных за период</p>
	{:else if asBars}
		<!-- ФТ-15.4: свыше восьми категорий — горизонтальная гистограмма -->
		<ul class="flex flex-col gap-2">
			{#each sorted as s}
				<li
					class="grid grid-cols-[10rem_1fr_auto] items-center gap-3 text-sm"
					title={hint(s)}
					onmouseenter={() => (hoveredBar = s.label)}
					onmouseleave={() => (hoveredBar = null)}
				>
					<span class="truncate text-text-muted">{s.label}</span>
					<span class="h-4 w-full">
						<span
							class="block h-full rounded-r-[4px]"
							style="width: {(measure(s) / maxBar) * 100}%; background: {SERIES[0]}"
						></span>
					</span>
					<span class="tabular-nums">{show(measure(s))}</span>
				</li>
			{/each}
		</ul>
	{:else}
		<!-- на широкой карточке кольцо и легенда встают в ряд: колонкой они
		     оставляли пустые поля по бокам, а легенда жалась в узкую полосу -->
		<div class="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
			<div class="relative shrink-0">
				<svg
					viewBox="0 0 160 160"
					class="h-44 w-44 sm:h-52 sm:w-52"
					role="img"
					aria-label={title || caption}
				>
					<g transform="rotate(-90 80 80)">
						{#each arcs as a, i}
							<circle
								cx="80"
								cy="80"
								r={R}
								fill="none"
								stroke={a.color}
								stroke-width="18"
								stroke-dasharray="{a.len} {C - a.len}"
								stroke-dashoffset={-a.start}
								class="cursor-pointer transition-opacity duration-150"
								style="opacity: {hovered === null || hovered === i ? 1 : 0.35}"
								onmouseenter={() => (hovered = i)}
								onmouseleave={() => (hovered = null)}
								onclick={() => onselect?.(a)}
								role="presentation"
							/>
						{/each}
					</g>
				</svg>

				<!-- Число в центре: подписи текстовыми токенами, не цветом серии -->
				<div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
					<span class="text-3xl tabular-nums">{show(centerValue)}</span>
					<span class="max-w-36 truncate text-text-muted">{centerCaption}</span>
					{#if hasExtra && hovered === null}
						<!-- вторая величина итогом: обе цифры видны разом, без переключения -->
						<span class="max-w-36 truncate text-sm text-text-muted tabular-nums">
							{show(totalOther, !byExtra)}
						</span>
					{/if}
				</div>
			</div>

			<ul class="flex w-full grow flex-col">
				{#each arcs as a, i}
					<li>
						<button
							type="button"
							class="grid min-h-0 w-full grid-cols-[12px_1fr_auto_auto_3rem] items-center gap-2 rounded-sm px-1 py-1 text-left"
							style="background: {hovered === i ? 'var(--color-heat-empty)' : 'transparent'}"
							title={hint(a)}
							onmouseenter={() => (hovered = i)}
							onmouseleave={() => (hovered = null)}
							onclick={() => onselect?.(a)}
						>
							<span class="h-3 w-3 rounded-[2px]" style="background: {a.color}"></span>
							<span class="truncate">{a.label}</span>
							<span class="tabular-nums">{show(measure(a))}</span>
							<!-- вторая величина рядом, приглушённо: она объясняет первую -->
							<span class="text-sm text-text-muted tabular-nums">
								{hasExtra ? show(byExtra ? a.value : (a.extra ?? 0), !byExtra) : ''}
							</span>
							<span class="text-right text-text-muted tabular-nums">{pf(a.frac)}</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
