<script module lang="ts">
	export type WarningLevel = 'none' | 'informational' | 'significant' | 'critical';

	/** Одна ячейка календаря. date — ISO YYYY-MM-DD в местном времени компании. */
	export type DayStat = {
		date: string;
		flights: number;
		/** Наиболее серьёзный уровень предупреждений за день (ФТ-15.2) */
		level?: WarningLevel;
	};
</script>

<script lang="ts">
	import Pager from '$lib/components/Pager.svelte';

	/**
	 * Календарь полётов — тепловая карта по дням (ФТ-15.2).
	 * Насыщенность ячейки — число полётов за день.
	 * Оттенок — наиболее серьёзный уровень предупреждений: нейтральный / янтарный / красный.
	 */
	let {
		data = [],
		hot = null,
		onselect,
		onhover,
		onyear
	}: {
		data?: DayStat[];
		/**
		 * Дни, подсвеченные снаружи: курсор стоит на точке этого полёта на карте
		 * или на доле диаграммы — тогда подсвечиваются все дни этого борта или
		 * пилота. Связь двусторонняя: календарь так же подсвечивает точки
		 * на карте, когда курсор идёт по его ячейкам.
		 */
		hot?: string | string[] | null;
		onselect?: (day: DayStat) => void;
		/**
		 * Показываемый год: карта рядом показывает вылеты того же года.
		 * Сообщается и при первом показе — год мог оказаться не текущим,
		 * если в текущем ещё не летали.
		 */
		onyear?: (year: number) => void;
		/**
		 * Курсор над днём: карта рядом показывает точки вылетов этого дня.
		 * null — курсор ушёл с календаря. Клавиатура даёт то же событие
		 * фокусом, иначе связь календаря и карты была бы только для мыши.
		 */
		onhover?: (date: string | null) => void;
	} = $props();

	const DAY = 86_400_000;

	/**
	 * Показываемый год. Хранится в самом календаре: переключают его здесь же,
	 * кнопками в заголовке, а данные приходят из журнала полётов целиком —
	 * за какой год их показать, снаружи знать не нужно.
	 */
	let year = $state(new Date().getFullYear());

	/**
	 * Годы, между которыми листает календарь: ровно те, в которых есть полёты.
	 * Пустых лет в списке нет — показывать нечего, а листание сквозь пустоту
	 * только сбивает. Журнал пока за один год — листания не будет вовсе.
	 */
	const years = $derived.by(() => {
		const all = new Set(data.map((d) => Number(d.date.slice(0, 4))).filter(Number.isFinite));
		if (all.size === 0) all.add(new Date().getFullYear());
		return [...all].sort((a, b) => a - b);
	});

	// журнал мог начаться позже или закончиться раньше открытого года:
	// показываем ближайший год, в котором полёты есть
	$effect(() => {
		if (!years.includes(year)) year = years[years.length - 1];
	});

	// год ушёл наружу: календарь и карта рядом обязаны показывать одно и то же
	$effect(() => onyear?.(year));

	function iso(d: Date): string {
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
			d.getDate()
		).padStart(2, '0')}`;
	}

	/** Понедельник = 0, воскресенье = 6 */
	function dow(d: Date): number {
		return (d.getDay() + 6) % 7;
	}

	const byDate = $derived(new Map(data.map((d) => [d.date, d])));

	/** Подсвеченные снаружи дни: одна дата или сразу несколько */
	const marks = $derived(new Set(hot === null ? [] : typeof hot === 'string' ? [hot] : hot));

	/**
	 * Сетка заполняется по столбцам: столбец — неделя, строка — день недели.
	 * Показывается ровно выбранный год: от понедельника, с которого начинается
	 * неделя 1 января, до воскресенья, которым заканчивается неделя 31 декабря.
	 * Отсюда же берётся число столбцов — у года их 52 или 53, поровну не делится.
	 */
	const days = $derived.by(() => {
		const first = new Date(year, 0, 1);
		const last = new Date(year, 11, 31);
		const start = new Date(year, 0, 1 - dow(first));
		const total = (last.getTime() - start.getTime()) / DAY + (7 - dow(last));

		const out: { date: string; d: Date; stat?: DayStat; future: boolean }[] = [];
		const today = iso(new Date());
		for (let i = 0; i < Math.round(total); i++) {
			// шаг датой, а не миллисекундами: сутки не всегда ровно 24 часа
			const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
			const key = iso(d);
			out.push({ date: key, d, stat: byDate.get(key), future: key > today });
		}
		return out;
	});

	const weeks = $derived(days.length / 7);

	const maxFlights = $derived(Math.max(1, ...data.map((d) => d.flights)));

	/** Четыре ступени насыщенности, как в журнале активности GitHub. */
	function bucket(n: number): number {
		if (n <= 0) return 0;
		const q = n / maxFlights;
		if (q <= 0.25) return 1;
		if (q <= 0.5) return 2;
		if (q <= 0.75) return 3;
		return 4;
	}

	const MIX = [0, 32, 56, 80, 100];

	/** Пустая ячейка. Светлее панели — иначе сетка сливается с ней.
	    Ступени насыщенности подмешиваются к этому же цвету. */
	const EMPTY = 'var(--color-bg)';

	/**
	 * День с предупреждениями красный, обычный — зелёный. Оттенок здесь не
	 * степень тревоги, а признак «в этот день что-то пошло не так»: в сетке
	 * из трёхсот ячеек различать два тревожных оттенка глазом всё равно
	 * не выходит, а красное пятно среди зелёных видно сразу.
	 * Информационный уровень остаётся жёлтым: он ни о чём не предупреждает.
	 */
	function hue(level: WarningLevel | undefined): string {
		if (level === 'critical' || level === 'significant') return 'var(--color-heat-critical)';
		if (level === 'informational') return 'var(--color-heat-bad)';
		return 'var(--color-heat-good)';
	}

	/**
	 * Цвет ячейки читается в два шага, и порядок здесь важнее оттенков.
	 *
	 * Сначала вопрос «было ли предупреждение». Если было — день красный целиком,
	 * в полную силу, сколько бы полётов в нём ни прошло удачно: три успешных
	 * вылета не отменяют один с замечанием, а разбавленный красный на фоне
	 * зелёной сетки читается как «наверное, всё нормально».
	 *
	 * И только у спокойного дня насыщенность зелёного говорит о загрузке:
	 * чем больше полётов, тем ярче. Число полётов при этом не теряется —
	 * оно в подписи ячейки.
	 */
	function cellStyle(stat: DayStat | undefined, future = false): string {
		// день ещё не наступил — ячейка пустая, но она есть: сетка года
		// показывается целиком, иначе календарь выглядит обрезанным по сегодня
		if (future) return `background: ${EMPTY}`;

		if (stat?.level !== undefined && stat.level !== 'none') {
			return `background: ${hue(stat.level)}`;
		}

		const b = bucket(stat?.flights ?? 0);
		if (b === 0) return `background: ${EMPTY}`;
		return `background: color-mix(in oklab, ${hue(stat?.level)} ${MIX[b]}%, ${EMPTY})`;
	}

	/**
	 * Подсветка дня, на точку которого навели курсор на карте. Обводкой,
	 * а не заливкой: заливка занята числом полётов и уровнем предупреждений,
	 * и подменять её значило бы соврать о самом дне.
	 */
	const HOT = '; outline: 2px solid var(--color-heat-bad); outline-offset: 1px';

	function legendStyle(b: number): string {
		return b === 0
			? `background: ${EMPTY}`
			: `background: color-mix(in oklab, var(--color-heat-good) ${MIX[b]}%, ${EMPTY})`;
	}

	const fmtDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
	const fmtMonth = new Intl.DateTimeFormat('ru-RU', { month: 'short' });

	function plural(n: number): string {
		const t = n % 10,
			h = n % 100;
		if (t === 1 && h !== 11) return 'полёт';
		if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return 'полёта';
		return 'полётов';
	}

	const LEVEL_RU: Record<WarningLevel, string> = {
		none: '',
		informational: ', информационные предупреждения',
		significant: ', существенные предупреждения',
		critical: ', критические предупреждения'
	};

	function label(cell: { date: string; d: Date; stat?: DayStat; future?: boolean }): string {
		// будущему дню сказать нечего, кроме даты: «полётов нет» там означало бы,
		// что их не было, а они просто ещё не наступили
		if (cell.future) return fmtDay.format(cell.d);

		const n = cell.stat?.flights ?? 0;
		const lvl = cell.stat?.level;
		return n === 0
			? `${fmtDay.format(cell.d)} — полётов нет`
			: `${fmtDay.format(cell.d)} — ${n} ${plural(n)}${lvl && lvl !== 'none' ? LEVEL_RU[lvl] : ''}`;
	}

	/** Подпись месяца ставится над столбцом, в котором месяц начинается. */
	const months = $derived.by(() => {
		const out: { col: number; text: string }[] = [];
		for (let col = 0; col < weeks; col++) {
			const first = days[col * 7];
			if (!first) continue;
			const prev = col > 0 ? days[(col - 1) * 7] : undefined;
			if (!prev || prev.d.getMonth() !== first.d.getMonth()) {
				// не лепим подпись впритык к предыдущей
				if (out.length === 0 || col - out[out.length - 1].col >= 3) {
					out.push({ col, text: fmtMonth.format(first.d).replace('.', '') });
				}
			}
		}
		return out;
	});

	const DOW = ['Пн', '', 'Ср', '', 'Пт', '', ''];
</script>

<section class="flex flex-col gap-2 rounded-lg border bg-front p-4">
	<header class="mb-4 flex items-center justify-between gap-3">
		<h2 class="text-2xl">Календарь полётов БВС</h2>

		<!-- годы листаются тем же набором кнопок, что и страницы таблиц.
		     Год в журнале один — листать нечего, и кнопок не будет -->
		<Pager
			page={Math.max(1, years.indexOf(year) + 1)}
			count={years.length}
			label={(p) => years[p - 1]}
			back="Предыдущий год"
			forward="Следующий год"
			title="Годы"
			onchange={(p) => (year = years[p - 1])}
		/>
	</header>
	<div class="flex flex-col gap-3" style="--weeks: {weeks}; --cell: 14px; --gap: 4px">
		<!-- Год не влезает в узкий экран — прокручивается календарь, а не страница -->
		<div
			class="grid grid-cols-[auto_1fr] grid-rows-[auto_auto] gap-x-1.5 gap-y-1 overflow-x-auto pb-1"
		>
			<div></div>

			<div
				class="grid h-4 grid-cols-[repeat(var(--weeks),var(--cell))] gap-(--gap) text-sm text-text-muted"
			>
				{#each months as m}
					<span class="whitespace-nowrap" style="grid-column: {m.col + 1}">{m.text}</span>
				{/each}
			</div>

			<div
				class="grid grid-rows-[repeat(7,var(--cell))] gap-(--gap) text-right text-sm leading-(--cell) text-text-muted"
			>
				{#each DOW as d}<span>{d}</span>{/each}
			</div>

			<div
				class="grid grid-flow-col grid-cols-[repeat(var(--weeks),var(--cell))] grid-rows-[repeat(7,var(--cell))] gap-(--gap)"
				role="grid"
				aria-label="Календарь полётов за период"
			>
				{#each days as cell (cell.date)}
					<button
						type="button"
						class={[
							'click bg-red h-(--cell) min-h-0 w-(--cell) rounded-[2px] p-0',
							'',
							cell.future && 'cursor-default border-transparent hover:outline-none'
						]}
						style={cellStyle(cell.stat, cell.future) + (marks.has(cell.date) ? HOT : '')}
						title={label(cell)}
						aria-label={label(cell)}
						disabled={cell.future}
						onclick={() => onselect?.(cell.stat ?? { date: cell.date, flights: 0 })}
						onmouseenter={() => onhover?.(cell.date)}
						onmouseleave={() => onhover?.(null)}
						onfocus={() => onhover?.(cell.date)}
						onblur={() => onhover?.(null)}
					></button>
				{/each}
			</div>
		</div>

		<div class="flex items-center gap-[3px] text-[11px]">
			<span class="mx-1 text-text-muted">Меньше</span>
			{#each [0, 1, 2, 3, 4] as b}
				<span
					class="h-(--cell) w-(--cell) rounded-[2px] border border-white/5"
					style={legendStyle(b)}
				></span>
			{/each}
			<span class="mx-1 text-text-muted">Больше</span>

			<span class="mx-2 h-3 w-px bg-border"></span>
			<span
				class="h-(--cell) w-(--cell) rounded-[2px] border border-white/5"
				style="background: var(--color-heat-critical)"
			></span>
			<span class="mx-1 text-text-muted">Дни с предупреждениями</span>
		</div>
	</div>
</section>
