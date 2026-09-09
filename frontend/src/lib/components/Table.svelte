<script module lang="ts">
	/** Границы отбора по столбцу: включительно, пустая строка — без ограничения */
	export type Range = { from: string; to: string };
</script>

<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { fade } from 'svelte/transition';
	import calendarIcon from '$lib/assets/calendar.svg?raw';
	import clockIcon from '$lib/assets/clock.svg?raw';
	import Modal from '$lib/components/Modal.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import Tag from '$lib/components/Tag.svelte';
	import {
		cellText,
		duration,
		hours,
		num,
		plain,
		showDate,
		TONE,
		type Column,
		type Row,
		type TableAction
	} from '$lib/components/format';

	/**
	 * Универсальная таблица: журнал полётов (ФТ-10), парк БВС (ФТ-3), штат (ФТ-2),
	 * учёт полётов (ФТ-5, ФТ-15.3).
	 * Настольный экран (НФТ-5.4). Сортировка по столбцу и поиск (ФТ-10.11).
	 *
	 * Всё, что различается между экранами, приходит пропсами: столбцы (columns),
	 * кнопки над таблицей (toolbar) и, если стандартных форматов не хватает,
	 * сниппет cell для столбцов с format: 'custom'.
	 * Действия над записью живут в карточке, которую открывает onselect.
	 */
	let {
		data = [],
		columns = [],
		title = '',
		defaultSort,
		defaultAsc = false,
		perPage = 'auto',
		focus,
		toolbar = [],
		ranges = {},
		onselect,
		onrange,
		cell,
		controls
	}: {
		data?: Row[];
		columns?: Column[];
		title?: string;
		defaultSort?: string;
		/** направление сортировки по умолчанию: ручной порядок читается сверху вниз */
		defaultAsc?: boolean;
		/**
		 * Сколько строк на странице:
		 * 'auto' — считается по высоте окна, чтобы таблица влезла без прокрутки,
		 * число — фиксировано, 0 — показывать всё сразу.
		 */
		perPage?: number | 'auto';
		/**
		 * id записи, которую нужно показать: таблица перелистнётся на её страницу
		 * и подсветит строку. Нужно после добавления и правки — иначе новая запись
		 * уезжает в конец сортировки, и кажется, что ничего не добавилось.
		 */
		focus?: string;
		/** кнопки над таблицей, справа от поиска */
		toolbar?: TableAction[];
		/**
		 * Начальные границы отбора по столбцам: { date: { from, to } }.
		 * Приходят снаружи, когда отбор должен переживать переход по ссылке —
		 * в учёте полётов он хранится в адресе страницы.
		 */
		ranges?: Record<string, Range>;
		/** Границы изменили в шапке: страница может записать их в адрес */
		onrange?: (key: string, range: Range) => void;
		onselect?: (row: Row) => void;
		/** отрисовка ячеек столбцов с format: 'custom' */
		cell?: Snippet<[Row, Column, number]>;
		/**
		 * Свои средства отбора в шапке, слева от поиска: период дат в учёте
		 * полётов. Общими их не делаем — отбор у каждой таблицы свой, а место
		 * под него одно и то же.
		 */
		controls?: Snippet;
	} = $props();

	/** Единый текст пустого состояния: и когда данных нет, и когда поиск ничего не нашёл */
	const EMPTY = 'Пусто';

	/**
	 * Отбор по столбцу: границы включительно, пустая граница — «без ограничения».
	 * Даты и время суток хранятся строками ISO и ЧЧ:ММ:СС, а такие строки
	 * сравниваются как есть — переводить их в числа незачем.
	 */
	let picked = $state<Record<string, Range>>({});

	// границы приходят снаружи (адрес страницы) и оттуда же обновляются:
	// таблица их показывает, а хранит тот, кто умеет переживать перезагрузку
	$effect(() => {
		picked = { ...ranges };
	});

	/** Какой столбец сейчас показывает своё окно отбора */
	let opened = $state('');

	const openedColumn = $derived(columns.find((c) => c.key === opened && c.filter));

	function edge(key: string, side: 'from' | 'to', value: string) {
		const next = { ...(picked[key] ?? { from: '', to: '' }), [side]: value };
		picked = { ...picked, [key]: next };
		onrange?.(key, next);
	}

	/** Обе границы разом: готовый период ставится одним действием */
	function setRange(key: string, from: string, to: string) {
		const next = { from, to };
		picked = { ...picked, [key]: next };
		onrange?.(key, next);
		opened = '';
	}

	/** ISO-дата на столько дней назад от сегодня */
	function daysAgo(days: number): string {
		const d = new Date();
		d.setDate(d.getDate() - days);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

	const today = () => daysAgo(0);

	/** Готовые периоды для дат: их спрашивают чаще всего, а набирать долго */
	const PERIODS = [
		{ text: 'Неделя', days: 7 },
		{ text: 'Месяц', days: 30 },
		{ text: 'Год', days: 365 }
	];

	/**
	 * Выбранные границы словами. Показываются прямо в шапке вместо значка:
	 * отбор, которого не видно, — это таблица, которая необъяснимо
	 * недосчитывает строк.
	 */
	function rangeText(key: string, kind: Column['filter']): string {
		const r = picked[key];
		if (!r) return '';
		const one = (v: string) => (kind === 'date' ? showDate(v) : v.slice(0, 5));
		if (r.from && r.to) return `${one(r.from)} — ${one(r.to)}`;
		return r.from ? `с ${one(r.from)}` : `по ${one(r.to)}`;
	}

	function clearRange(key: string) {
		const next = { from: '', to: '' };
		picked = { ...picked, [key]: next };
		onrange?.(key, next);
		opened = '';
	}

	const active = (key: string) => !!(picked[key]?.from || picked[key]?.to);

	let query = $state('');
	let page = $state(1);

	/**
	 * Сортировка одним значением: столбец и направление вместе, `null` —
	 * сортировки нет, строки идут как в данных. Двумя переменными это
	 * состояние не выражается: «столбец не выбран» и «направление» —
	 * не независимые величины, и отменить сортировку было нечем.
	 *
	 * Начальное значение берётся из пропсов один раз: дальше порядком
	 * распоряжается тот, кто смотрит таблицу.
	 */
	let sortPick = $state<{ key: string; asc: boolean } | null>(
		untrack(() => {
			const key = defaultSort ?? columns.find(sortable)?.key ?? '';
			return key ? { key, asc: defaultAsc } : null;
		})
	);
	/**
	 * Измерения для perPage: 'auto'. Высоту строки и свободное место берём из
	 * разметки, а не из констант: строка с кнопками-иконками выше текстовой,
	 * а поля страницы могут поменяться в вёрстке.
	 */
	let winH = $state(0);
	let rowH = $state(0);
	let freeH = $state(0);
	let sectionEl = $state<HTMLElement>();
	let tbodyEl = $state<HTMLTableSectionElement>();
	let pagerEl = $state<HTMLElement>();

	/** Пока ничего не измерено — расчётное значение под экран 1080p */
	const FALLBACK = 12;

	function measure() {
		const first = tbodyEl?.rows[0];
		if (!sectionEl || !tbodyEl || !first) return;

		rowH = first.getBoundingClientRect().height;

		const tb = tbodyEl.getBoundingClientRect();
		const sec = sectionEl.getBoundingClientRect();
		// от конца строк до конца секции: отступ, пагинатор, нижнее поле секции.
		// Пагинатор отрисован всегда, поэтому высота не скачет и расчёт не зацикливается
		const below = sec.bottom - tb.bottom;
		// то, что идёт под самой таблицей: нижнее поле страницы и соседние блоки.
		// Берём рамку body, а не scrollHeight: тот не бывает меньше окна, и на
		// короткой таблице «свободное место» получалось отрицательным — число
		// строк схлопывалось до минимума, стоило удалить запись
		const body = document.body.getBoundingClientRect();
		const outer = Math.max(0, body.bottom - sec.bottom);

		// координаты приводим к документу: иначе прокрутка меняла бы результат
		freeH = window.innerHeight - (tb.top + window.scrollY) - below - outer;
	}

	$effect(() => {
		// пересчёт при изменении окна, набора столбцов и числа найденных строк
		winH;
		columns;
		rows.length;
		measure();
	});

	/** Сколько строк помещается. Меньше трёх таблица не показывает — это уже не таблица */
	const fit = $derived(rowH > 0 ? Math.max(3, Math.floor(freeH / rowH)) : 0);
	const size = $derived(perPage === 'auto' ? fit || FALLBACK : perPage);

	/** По служебным столбцам (номер, действия, свой рендер) сортировать нечего */
	function sortable(c: Column): boolean {
		return c.sortable ?? !['index', 'custom'].includes(c.format ?? 'text');
	}

	const sortKey = $derived(sortPick?.key ?? '');
	const sortAsc = $derived(sortPick?.asc ?? false);

	function sortValue(row: Row, key: string): string | number {
		const v = row[key];
		// примечания сортируются по количеству, а не по тексту первого из них
		if (Array.isArray(v)) return v.length;
		return typeof v === 'number' ? v : String(v ?? '');
	}

	/**
	 * Последний столбец: у него окно отбора открывается влево, иначе оно
	 * уезжает за край таблицы. Выравнивание при этом у всех столбцов одно —
	 * по левому краю: взгляд идёт по одной линии сверху вниз, а прижатый
	 * вправо хвост заставляет его перескакивать.
	 */
	const last = $derived(columns.length - 1);

	const searchKeys = $derived(
		columns
			.filter((c) => c.search !== false && ['text', 'notes'].includes(c.format ?? 'text'))
			.map((c) => c.key)
	);

	/** Столбцы, у которых есть свой отбор */
	const rangeKeys = $derived(columns.filter((c) => c.filter).map((c) => c.key));

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();

		return data.filter((r) => {
			for (const key of rangeKeys) {
				const range = picked[key];
				if (!range?.from && !range?.to) continue;
				const v = String(r[key] ?? '');
				// пустое значение под отбор не подходит: у полёта без посадки
				// нет времени конца, и в промежуток времени он не попадает
				if (!v) return false;
				if (range.from && v < range.from) return false;
				if (range.to && v > range.to) return false;
			}

			if (!q) return true;
			return searchKeys.some((k) =>
				String(r[k] ?? '')
					.toLowerCase()
					.includes(q)
			);
		});
	});

	/** Пустое значение: у полёта без посадки нет времени конца */
	const nothing = (v: string | number) => v === '' || v === null || v === undefined;

	const rows = $derived.by(() => {
		// сортировку отменили — показываем данные в том порядке, в каком пришли
		if (!sortPick) return filtered;

		return [...filtered].sort((a, b) => {
			const x = sortValue(a, sortKey);
			const y = sortValue(b, sortKey);

			// пустые всегда внизу, в обе стороны: «полёт ещё не сел» — это не
			// «самое раннее время», и наверху списка ему делать нечего
			if (nothing(x) || nothing(y)) return nothing(x) && nothing(y) ? 0 : nothing(x) ? 1 : -1;

			const r =
				typeof x === 'number' && typeof y === 'number'
					? x - y
					: String(x).localeCompare(String(y), 'ru');
			return sortAsc ? r : -r;
		});
	});

	/**
	 * Три состояния по кругу: по убыванию → по возрастанию → без сортировки.
	 * Третье нажатие возвращает порядок данных — иначе выбранную однажды
	 * сортировку нечем отменить, а исходный порядок часто и есть нужный:
	 * в журнале это порядок записи полётов.
	 */
	function toggleSort(key: string) {
		if (sortPick?.key !== key) sortPick = { key, asc: false };
		else if (!sortPick.asc) sortPick = { key, asc: true };
		else sortPick = null;
	}

	const pageCount = $derived(size > 0 ? Math.max(1, Math.ceil(rows.length / size)) : 1);
	const start = $derived(size > 0 ? (page - 1) * size : 0);
	const paged = $derived(size > 0 ? rows.slice(start, start + size) : rows);

	// поиск, отбор и сортировка меняют выборку — возвращаемся к первой странице
	$effect(() => {
		query;
		sortPick;
		picked;
		page = 1;
	});

	// строки могли кончиться: отмена полёта, фильтр, смена данных
	$effect(() => {
		if (page > pageCount) page = pageCount;
	});

	// показать страницу с нужной записью: она могла попасть в конец сортировки
	$effect(() => {
		if (!focus || size <= 0) return;
		const i = rows.findIndex((r) => r.id === focus);
		if (i >= 0) page = Math.floor(i / size) + 1;
	});

	/**
	 * Значение для выгрузки. Отличается от того, что видно в ячейке: числа идут
	 * без разделителей разрядов, даты — в ISO, пустое остаётся пустым, а не
	 * прочерком. Это нужно, чтобы Excel распознал числа и даты, а не текст.
	 */
	function exported(row: Row, c: Column, i: number): string {
		if (c.format === 'index') return String(i + 1);
		const v = row[c.key];
		if (v === undefined || v === null || v === '') return '';
		if (Array.isArray(v)) return v.join('; ');
		if (c.format === 'duration') return duration(Number(v));
		if (c.format === 'hours') return hours(Number(v));
		if (c.format === 'number') return String(v);
		return String(c.map?.[String(v)] ?? v);
	}

	/** Экранирование по правилам CSV: кавычки удваиваются, спорное берётся в кавычки */
	function csv(value: string): string {
		return /[";\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
	}

	/**
	 * Выгрузка таблицы в файл для Excel.
	 *
	 * Выгружается вся найденная выборка, а не текущая страница: пагинатор —
	 * способ смотреть, а не ограничение данных. Разделитель «точка с запятой»
	 * и метка BOM в начале — иначе Excel в русской локали разложит строку
	 * в один столбец и покажет кириллицу кракозябрами.
	 */
	function download() {
		const cols = columns.filter((c) => (c.format ?? 'text') !== 'custom');
		const head = cols.map((c) => csv(c.title));
		const body = rows.map((row, i) => cols.map((c) => csv(exported(row, c, i))));
		const text = [head, ...body].map((line) => line.join(';')).join('\r\n');

		const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = `${(title || 'таблица').replace(/[\\/:*?"<>|]/g, '')}.csv`;
		link.click();
		URL.revokeObjectURL(link.href);
	}

	/**
	 * Сколько строк не хватает до полной страницы. Добираем пустотой, иначе на
	 * последней странице таблица подскакивает вверх вместе с пагинатором.
	 * Пока страница одна, ничего не добираем: после узкого поиска не нужен
	 * пустой блок во весь экран.
	 */
	const fillers = $derived(pageCount > 1 && size > 0 ? size - paged.length : 0);

	const sums = $derived.by(() => {
		const out: Record<string, number> = {};
		for (const c of columns) {
			if (c.sum) out[c.key] = rows.reduce((n, r) => n + (Number(r[c.key]) || 0), 0);
		}
		return out;
	});
	const hasSums = $derived(Object.keys(sums).length > 0);
</script>

<!-- окно отбора закрывается щелчком мимо и по Escape: оно висит поверх
     таблицы, и оставлять его открытым при работе со строками неудобно -->
<!-- отбор живёт в модальном окне, и закрывается оно само: щелчок мимо
     и Escape ловить здесь больше не нужно -->
<svelte:window bind:innerHeight={winH} />

<section bind:this={sectionEl} class="flex flex-col gap-4 rounded-lg border bg-front p-4">
	<header class="flex items-center justify-between gap-4">
		{#if title}<h2 class="text-2xl">{title}</h2>{/if}

		<div class="flex flex-wrap items-center justify-end gap-2">
			{@render controls?.()}

			{#if searchKeys.length > 0}
				<input
					type="search"
					bind:value={query}
					placeholder="Поиск"
					class="min-h-0 w-72 rounded-sm bg-bg px-2 py-1 text-sm"
				/>
			{/if}

			{#each toolbar as t (t.key)}
				<button
					type="button"
					title={t.title ?? t.label}
					disabled={t.disabled ?? false}
					class="inline-flex min-h-0 cursor-pointer items-center gap-2 rounded-sm border px-3 py-1 text-sm whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4 {TONE[
						t.tone ?? 'default'
					]}"
					onclick={t.onclick}
				>
					{#if t.icon}{@html t.icon}{/if}
					{t.label}
				</button>
			{/each}
		</div>
	</header>

	{#if rows.length === 0}
		<p class="py-8 text-center text-sm text-text-muted">
			{EMPTY}
		</p>
	{:else}
		<div class="overflow-x-auto">
			<!-- separate, а не collapse: при склеенных границах разделительная линия
				     принадлежит сетке таблицы и остаётся снаружи подсветки строки.
				     В раздельной модели фон ячейки покрывает и её границу -->
			<table class="w-full border-separate border-spacing-0 text-sm">
				<thead>
					<tr class="text-text-muted">
						{#each columns as c, ci}
							<th class="relative border-b p-0 font-bold">
								<span class="flex items-center gap-1">
									{#if sortable(c)}
										<button
											type="button"
											class="click min-h-0 w-full cursor-pointer px-2 py-2 text-left whitespace-nowrap"
											class:text-accent={sortKey === c.key}
											title="Сортировка: по убыванию, по возрастанию, без сортировки"
											onclick={() => toggleSort(c.key)}
										>
											<!-- стрелка цвет не задаёт: наследует акцент от кнопки активного столбца -->
											{c.title}{#if sortKey === c.key}<span>{sortAsc ? ' ↑' : ' ↓'}</span>{/if}
										</button>
									{:else}
										<div class="w-full px-2 py-2 text-left whitespace-nowrap">
											{c.title}
										</div>
									{/if}

									{#if c.filter}
										<!-- отбор отдельной кнопкой рядом с сортировкой: «в каком порядке»
										     и «что показывать» — разные вопросы, и путать их нельзя.
										     Значок по типу столбца: календарь у дат, часы у времени -->
										<button
											type="button"
											class="click min-h-0 shrink-0 cursor-pointer rounded-sm px-1.5 py-1 [&_svg]:h-4 [&_svg]:w-4"
											class:text-accent={active(c.key)}
											class:text-text-muted={!active(c.key)}
											title={c.filter === 'date' ? 'Период дат' : 'Промежуток времени'}
											aria-label="Отбор по столбцу «{c.title}»"
											onclick={(e) => {
												e.stopPropagation();
												opened = c.key;
											}}
										>
											<span class="flex items-center gap-1.5 whitespace-nowrap">
												{@html c.filter === 'date' ? calendarIcon : clockIcon}
												<!-- когда границы заданы, они и написаны рядом со значком:
												     отбор виден, не открывая окно -->
												{#if active(c.key)}{rangeText(c.key, c.filter)}{/if}
											</span>
										</button>
									{/if}
								</span>
							</th>
						{/each}
					</tr>
				</thead>

				{#key page}
					<!-- только in: уходящий переход держал бы старые строки в потоке,
					     и на время анимации в таблице оказалось бы вдвое больше строк -->
					<tbody bind:this={tbodyEl} in:fade={{ duration: prefersReducedMotion.current ? 0 : 120 }}>
						{#each paged as row, i (row.id)}
							<!-- подсветка показывает, что именно добавили или изменили -->
							<tr
								class={row.id === focus ? 'group bg-accent/10' : 'group'}
								class:cursor-pointer={onselect}
								onclick={() => onselect?.(row)}
							>
								{#each columns as c, ci}
									<td
										class="px-2 py-2 text-left group-hover:bg-bg"
										class:border-b={i !== paged.length - 1}
										class:text-text-alt={ci % 2 === 1}
										class:tabular-nums={c.num}
										class:whitespace-nowrap={c.format !== 'text' || c.num}
									>
										{#if c.format === 'index'}
											<span class="text-text-muted tabular-nums">{start + i + 1}</span>
										{:else if c.format === 'notes'}
											{@const notes = (row[c.key] ?? []) as string[]}
											<!-- ноль, а не прочерк: количество примечаний — величина, её и показываем -->
											<span
												class="tabular-nums"
												class:text-text-muted={notes.length === 0}
												title={notes.length > 0 ? notes.join('\n') : undefined}
											>
												{notes.length}
											</span>
										{:else if c.format === 'custom'}
											{@render cell?.(row, c, i)}
										{:else if c.format === 'status'}
											{@const lvl = c.level?.(row) ?? c.levels?.[String(row[c.key])] ?? 'muted'}
											<!-- цвет не единственный признак: название статуса написано в теге -->
											<Tag level={lvl}>{row[c.key]}</Tag>
										{:else}
											{cellText(row, c)}
										{/if}
									</td>
								{/each}
							</tr>
						{/each}

						{#if fillers > 0 && rowH > 0}
							<tr aria-hidden="true">
								<td colspan={columns.length} style="height: {fillers * rowH}px"></td>
							</tr>
						{/if}
					</tbody>
				{/key}
			</table>
		</div>

		<!-- листание общее с календарём: набор кнопок один на всё приложение -->
		<div bind:this={pagerEl}>
			<Pager {page} count={pageCount} onchange={(p) => (page = p)}>
				<!-- выгрузка слева, листание справа: разные задачи не должны смешиваться -->
				<button
					type="button"
					class="mr-auto min-h-0 cursor-pointer rounded-sm border px-2 py-1 {TONE.accent}"
					onclick={download}
				>
					Скачать таблицу
				</button>

				{#if pageCount > 1}
					<!-- счётчик строк нужен только там, где есть листание -->
					<span class="mr-2 text-text-muted tabular-nums">
						{start + 1}–{start + paged.length} из {rows.length}
					</span>
				{/if}
			</Pager>
		</div>
	{/if}
</section>

<!-- отбор по столбцу — тем же модальным окном, что и карточки записей:
     всплывающая панелька под заголовком жила по своим правилам оформления
     и закрывалась от любого щелчка мимо -->
<Modal
	show={openedColumn !== undefined}
	title={openedColumn
		? openedColumn.filter === 'date'
			? `Период: ${openedColumn.title.toLowerCase()}`
			: `Промежуток: ${openedColumn.title.toLowerCase()}`
		: ''}
	onclose={() => (opened = '')}
>
	{#if openedColumn}
		{@const key = openedColumn.key}
		{@const kind = openedColumn.filter}
		<div class="flex flex-col gap-4">
			{#if kind === 'date'}
				<!-- «за последнюю неделю» спрашивают чаще, чем конкретные числа,
				     а набирать две даты ради этого долго -->
				<div class="flex flex-wrap gap-2">
					{#each PERIODS as p (p.days)}
						<button
							type="button"
							class="click min-h-0 grow cursor-pointer rounded-sm border px-3 py-2 text-text-muted"
							onclick={() => setRange(key, daysAgo(p.days), today())}
						>
							{p.text}
						</button>
					{/each}
				</div>
			{/if}

			<div class="flex flex-wrap items-end gap-3">
				<label class="flex grow flex-col gap-1">
					<span class="text-sm text-text-muted">с</span>
					<input
						type={kind}
						step={kind === 'time' ? 1 : undefined}
						value={picked[key]?.from ?? ''}
						class="min-h-0 w-full rounded-sm border bg-bg px-3 py-2"
						onchange={(e) => edge(key, 'from', e.currentTarget.value)}
					/>
				</label>
				<label class="flex grow flex-col gap-1">
					<span class="text-sm text-text-muted">по</span>
					<input
						type={kind}
						step={kind === 'time' ? 1 : undefined}
						value={picked[key]?.to ?? ''}
						class="min-h-0 w-full rounded-sm border bg-bg px-3 py-2"
						onchange={(e) => edge(key, 'to', e.currentTarget.value)}
					/>
				</label>
			</div>

			<button
				type="button"
				class="click min-h-0 cursor-pointer self-start rounded-sm border px-3 py-2 text-text-muted"
				onclick={() => clearRange(key)}
			>
				Сбросить
			</button>
		</div>
	{/if}
</Modal>
