<script lang="ts">
	import { goto } from '$app/navigation';
	import Calendar from '$lib/components/Calendar.svelte';
	import Diagram from '$lib/components/Diagram.svelte';
	import MapView, { type MapPoint } from '$lib/components/MapView.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Place from '$lib/components/Place.svelte';
	import Planned from '$lib/components/Planned.svelte';
	import { calendarDays } from '$lib/components/calendar.data';
	import { flightsByAircraft, flightsByPilot } from '$lib/components/diagram.data';
	import { FLIGHT_FIELDS } from '$lib/components/columns';
	import { duration, hasPoint, showDate } from '$lib/components/format';
	import { flights, isFlown } from '$lib/flights.svelte';
	import { runFor } from '$lib/runs.svelte';
	import type { FlightRow } from '$lib/mocs/rows';

	/** Год, открытый в календаре: панель целиком показывает этот год */
	let year = $state(new Date().getFullYear());

	/**
	 * Полёты выбранного года. Панель отвечает на вопросы «когда», «где» и
	 * «кто с чем» об одном и том же отрезке времени: календарь показывает год,
	 * а диаграммы под ним считают за всё время — это два разных ответа рядом,
	 * и сравнить их между собой нельзя.
	 */
	const ofYear = $derived(flights.filter((f) => f.date.startsWith(`${year}-`)));

	/**
	 * Панель считается из журнала полётов, а не из отдельных моков: закрыли полёт
	 * на площадке — и календарь с диаграммами уже это показывают.
	 *
	 * Календарь получает журнал целиком: он сам решает, какие годы показывать
	 * и между какими листать, и год для остальной панели задаёт тоже он.
	 */
	const days = $derived(calendarDays(flights));
	const byAircraft = $derived(flightsByAircraft(ofYear));
	const byPilot = $derived(flightsByPilot(ofYear));

	/** День, на который навели курсор в календаре: его вылеты выделяются на карте */
	let day = $state<string | null>(null);

	/**
	 * Полёт, на точку которого навели курсор на карте: его день подсвечивается
	 * в календаре. Связь та же, что и в обратную сторону, — «когда» и «где»
	 * отвечают друг другу с обеих сторон.
	 */
	let over = $state<string | null>(null);
	const overDay = $derived(over ? (flights.find((f) => f.id === over)?.date ?? null) : null);

	/**
	 * Доля диаграммы под курсором: борт или пилот. Их полёты подсвечиваются
	 * на карте и в календаре — вопрос «а где и когда он летал» задаётся ровно
	 * в тот момент, когда видишь его долю, и ответ должен быть рядом.
	 */
	let picked = $state<{ field: 'aircraft' | 'pilot'; labels: string[] } | null>(null);

	const related = $derived.by(() => {
		const p = picked;
		if (!p) return [];
		return ofYear.filter((f) => p.labels.includes(String(f[p.field] ?? '')));
	});

	const relatedIds = $derived(new Set(related.map((f) => f.id)));

	/** Дни, подсвеченные в календаре: точка под курсором и полёты выбранной доли */
	const hot = $derived([...(overDay ? [overDay] : []), ...related.map((f) => f.date)]);

	/**
	 * Полёт, открытый нажатием по точке. Карточка здесь только для чтения:
	 * панель отвечает на вопрос «что это за точка», а правят записи в учёте —
	 * туда из карточки ведёт ссылка.
	 */
	let shown = $state<FlightRow | null>(null);

	/**
	 * Точки вылетов на карте. Только состоявшиеся полёты — тем же правилом,
	 * что считает календарь: у плана координаты означают площадку, куда
	 * собираются лететь, а не точку взлёта, и в ячейке дня он не учтён.
	 * Календарь отвечает «когда», карта тут же отвечает «где», и расходиться
	 * между собой они не должны — в том числе годом.
	 */
	const points: MapPoint[] = $derived(
		ofYear
			.filter((f) => isFlown(f) && hasPoint(f.lat, f.lon))
			.map((f) => ({
				id: f.id,
				lat: f.lat,
				lon: f.lon,
				// в окне точки три поля карточки полёта как есть, без пересборки
				// и пересчёта: кто, на чём и зачем летал. Остальное — в карточке,
				// которая открывается нажатием
				label: f.pilot,
				lines: [f.aircraft, f.task],
				// выделено то, на что смотрят в соседнем блоке: день в календаре
				// или борт с пилотом в диаграмме
				active: (day !== null && f.date === day) || relatedIds.has(f.id)
			}))
	);
</script>

<section class="flex min-h-[calc(100vh_-_9rem)] w-full flex-col">
	<div class="flex min-h-80 w-full flex-1 flex-col gap-3 border-b">
		<!-- нажатие по точке открывает карточку полёта прямо здесь: вопрос
		     «что это за точка» не стоит ухода с панели -->
		<MapView
			{points}
			height="100%"
			zoom={11}
			onpoint={(id) => (shown = flights.find((f) => f.id === id) ?? null)}
			onover={(id) => (over = id)}
		/>
	</div>
	<div class="flex gap-5 px-4 py-4 md:px-15 md:py-10">
		<div class="flex w-full max-w-260 min-w-0 flex-col gap-6">
			<!-- наведение показывает точки дня на карте, нажатие уводит в журнал
		     за этот день: календарь отвечает «когда», журнал — «что именно» -->
			<Calendar
				data={days}
				{hot}
				onhover={(d) => (day = d)}
				onyear={(y) => (year = y)}
				onselect={(d) => goto(`/flights?date=${d.date}`)}
			/>

			<div class="flex flex-row gap-6">
				<!-- у долей две мерки: число вылетов и налёт. Переключатель в заголовке
			     диаграммы, вторая величина видна рядом с первой (ФТ-15.4, ФТ-15.7) -->
				<Diagram
					data={byAircraft}
					title="Статистика БВС"
					caption="полётов"
					extraCaption="налёт"
					formatExtra={duration}
					onover={(labels) => (picked = labels ? { field: 'aircraft', labels } : null)}
				/>
				<Diagram
					data={byPilot}
					title="По пилотам"
					caption="полётов"
					extraCaption="налёт"
					formatExtra={duration}
					onover={(labels) => (picked = labels ? { field: 'pilot', labels } : null)}
				/>
			</div>
		</div>

		<!-- планируемые полёты не растягивают панель: колонка занимает высоту
		     соседней, с календарём и диаграммами, а список прокручивается внутри.
		     Отсюда и absolute: список вне потока, и его длина на высоту строки
		     уже не влияет -->
		<div class="relative w-80 shrink-0">
			<div class="absolute inset-0 overflow-y-auto pr-1">
				<Planned />
			</div>
		</div>
	</div>
</section>

<!-- карточка полёта прямо на панели: точку нажали, чтобы узнать, что это,
     а не чтобы уйти со страницы. Правка живёт в учёте полётов -->
<Modal
	show={shown !== null}
	row={shown ?? undefined}
	fields={FLIGHT_FIELDS}
	table
	title={shown ? `Полёт № ${shown.no} · ${showDate(shown.date)}` : ''}
	onclose={() => (shown = null)}
>
	{#snippet field(row, column, editing)}
		{#if column.key === 'coords'}
			<Place {row} {editing} />
		{:else if column.key === 'checklist'}
			{#if runFor(row.id)}
				<!-- проверка была: по названию открывается её протокол -->
				<a href="/run?flight={row.id}" class="click text-accent">{row.checklist}</a>
			{:else}
				{row.checklist || '—'}
			{/if}
		{/if}
	{/snippet}

	{#if shown}
		<a
			href="/flights?flight={shown.id}"
			class="click self-start rounded-sm border px-3 py-1.5 text-sm text-text-muted"
		>
			Открыть в учёте полётов
		</a>
	{/if}
</Modal>
