<script lang="ts">
	import { page } from '$app/state';
	import MapView from '$lib/components/MapView.svelte';
	import Table from '$lib/components/Table.svelte';
	import Tag from '$lib/components/Tag.svelte';
	import { duration, hasPoint, lapse, showDate, sppi } from '$lib/components/format';
	import { RUN_COLUMNS } from '$lib/components/columns';
	import { flightById } from '$lib/flights.svelte';
	import { runsFor } from '$lib/runs.svelte';
	import { checklistFor } from '$lib/checklists.svelte';

	/**
	 * Протокол прохождения чеклиста — отдельная таблица только с параметрами
	 * проверки. Открывается из учёта полётов: в записи полёта ссылка на
	 * прохождение (ФТ-10.7), а разбирать проверку удобнее списком пунктов.
	 */
	const flight = $derived(flightById(page.url.searchParams.get('flight')));
	const history = $derived(flight ? runsFor(flight.id) : []);
	/**
	 * Открытое прохождение: названное в адресе, иначе последнее.
	 * Переключателя на экране нет — прежние прохождения открываются
	 * адресом /run?flight=<id>&run=<id>.
	 */
	const run = $derived(
		history.find((r) => r.id === page.url.searchParams.get('run')) ?? history[0]
	);

	/** Тип ответа берётся из чеклиста: в протоколе хранится значение, а не способ ввода */
	const kinds = $derived.by(() => {
		const list = flight
			? checklistFor(flight.aircraftId, flight.aircraft, flight.checklist)
			: undefined;
		return new Map((list?.items ?? []).map((i) => [i.id, i.kind]));
	});

	/**
	 * Обязательные параметры прохождения идут первыми строками таблицы:
	 * протокол читается одним списком сверху вниз, без отдельной шапки.
	 */
	const params = $derived(
		run
			? [
					['Дата', showDate(run.date)],
					['Начало проверки', run.startedAt],
					['Конец проверки', run.finishedAt || 'не закончена'],
					[
						'Длительность проверки',
						run.finishedAt ? duration(lapse(run.startedAt, run.finishedAt)) : '—'
					],
					['Локация', run.site || 'без названия'],
					['Координаты', sppi(run.lat, run.lon)],
					['Погода', run.weather || '—'],
					['Пилот', run.pilot],
					['Подпись', run.signature || 'не подписано'],
					['Версия чеклиста', run.version],
					...(run.description ? [['Описание', run.description]] : []),
					...(run.voided ? [['Аннулировано', run.voided]] : [])
				]
			: []
	);

	const rows = $derived([
		...params.map(([title, value], i) => ({
			id: `p-${i}`,
			pos: i,
			title,
			kind: '',
			value,
			note: ''
		})),
		...(run?.answers ?? []).map((a, i) => ({
			id: a.itemId,
			pos: params.length + i,
			title: a.title,
			kind: kinds.get(a.itemId) ?? '',
			value: a.value,
			note: a.note
		}))
	]);
</script>

<section class="flex w-full flex-col gap-4">
	{#if !flight}
		<p class="py-8 text-center text-text-muted">Полёт не найден</p>
	{:else if !run}
		<div class="flex flex-col items-center gap-4 rounded-lg border bg-front p-8">
			<p class="text-text-muted">По полёту № {flight.no} проверка не проводилась</p>
			<a href="/flights" class="click min-h-0 rounded-sm border px-3 py-1.5 text-text-muted">
				К учёту полётов
			</a>
		</div>
	{:else}
		<Table data={rows} columns={RUN_COLUMNS} title={run.checklist} defaultSort="pos" defaultAsc>
			{#snippet cell(row)}
				{#if row.value === null}
					<span class="text-text-muted">пропущено</span>
				{:else if typeof row.value === 'boolean'}
					<Tag level={row.value ? 'ok' : 'bad'}>
						{row.value ? 'соответствует' : 'не соответствует'}
					</Tag>
				{:else}
					<span class:tabular-nums={typeof row.value === 'number'}>{row.value}</span>
				{/if}
			{/snippet}
		</Table>

		{#if hasPoint(run.lat, run.lon)}
			<!-- координаты подписаны вместе с проверкой (ФТ-6.8); карта здесь
			     только показывает, где это было, — читать протокол она не мешает -->
			<div class="rounded-lg border bg-front p-4">
				<h3 class="mb-2 text-lg">Место проверки</h3>
				<MapView lat={run.lat} lon={run.lon} height="16rem" />
			</div>
		{/if}
	{/if}
</section>
