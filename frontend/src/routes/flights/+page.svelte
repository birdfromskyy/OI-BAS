<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Table from '$lib/components/Table.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Place from '$lib/components/Place.svelte';
	import type { Column, Row, TableAction } from '$lib/components/format';
	import type { Range } from '$lib/components/Table.svelte';
	import plane from '$lib/assets/plane.svg?raw';
	import { FLIGHT_COLUMNS, FLIGHT_FIELDS } from '$lib/components/columns';
	import { showDate, sppi } from '$lib/components/format';
	import { blankFlight, flights, isPlanned, removeFlight, saveFlight } from '$lib/flights.svelte';
	import { may, me, mine } from '$lib/session.svelte';
	import type { FlightRow } from '$lib/mocs/rows';
	import { aircraftByModel, fleetModels } from '$lib/fleet.svelte';
	import { listsFor } from '$lib/checklists.svelte';
	import { pilotNames } from '$lib/staff.svelte';
	import { runFor } from '$lib/runs.svelte';

	/** Открытая карточка; null — окно закрыто */
	let opened = $state<FlightRow | null>(null);

	/**
	 * Запись открывается адресом: с панели «Требует внимания» переходят
	 * к конкретному полёту (ФТ-15.13). Отмечаем открытый идентификатор,
	 * чтобы закрытая карточка не открывалась снова тем же адресом.
	 */
	let fromLink = $state('');
	$effect(() => {
		const id = page.url.searchParams.get('flight') ?? '';
		if (!id || id === fromLink) return;
		fromLink = id;
		opened = flights.find((f) => f.id === id) ?? null;
	});
	let creating = $state(false);
	/** Последняя добавленная или изменённая запись — таблица покажет её страницу */
	let touched = $state<string>();

	/**
	 * Отбор по столбцам живёт в адресе, а не в состоянии страницы: такую ссылку
	 * можно переслать, она откроет тот же отбор, и кнопка «назад» возвращает
	 * предыдущий. Таблица его показывает и правит, страница — хранит.
	 *
	 * `?date=` с календаря на панели — тот же период из одного дня: переход
	 * по нажатию на день не должен знать про две границы.
	 */
	const day = $derived(page.url.searchParams.get('date') ?? '');

	const ranges = $derived<Record<string, Range>>({
		date: {
			from: page.url.searchParams.get('from') || day,
			to: page.url.searchParams.get('to') || day
		},
		takeoff: {
			from: page.url.searchParams.get('after') ?? '',
			to: page.url.searchParams.get('before') ?? ''
		}
	});

	/** Какой параметр адреса отвечает за границу столбца */
	const PARAM: Record<string, [string, string]> = {
		date: ['from', 'to'],
		takeoff: ['after', 'before']
	};

	const picked = $derived(Object.values(ranges).some((r) => r.from || r.to));

	/** Заголовок объясняет, что именно показано: день, период или весь журнал */
	const heading = $derived(
		!ranges.date.from && !ranges.date.to
			? picked
				? 'Учёт полётов · отбор'
				: 'Учёт полётов'
			: ranges.date.from === ranges.date.to
				? `Полёты за ${showDate(ranges.date.from)}`
				: ranges.date.from && ranges.date.to
					? `Полёты с ${showDate(ranges.date.from)} по ${showDate(ranges.date.to)}`
					: ranges.date.from
						? `Полёты с ${showDate(ranges.date.from)}`
						: `Полёты по ${showDate(ranges.date.to)}`
	);

	/** Границы столбца изменили в таблице — переносим их в адрес */
	function setRange(key: string, range: Range) {
		const names = PARAM[key];
		if (!names) return;

		const url = new URL(page.url);
		// день с календаря разворачивается в период, иначе правка одной границы
		// потеряла бы вторую
		url.searchParams.delete('date');
		if (key === 'date' && day) {
			url.searchParams.set('from', day);
			url.searchParams.set('to', day);
		}

		for (const [i, name] of names.entries()) {
			const value = i === 0 ? range.from : range.to;
			if (value) url.searchParams.set(name, value);
			else url.searchParams.delete(name);
		}

		goto(`${url.pathname}${url.search}`, { replaceState: true, keepFocus: true, noScroll: true });
	}

	/**
	 * Кого можно поставить пилотом. Пилот планирует только за себя (сноска ²
	 * матрицы 2.2), поэтому выбор ему не нужен; администратор планирует за
	 * любого — у него в списке весь штат.
	 */
	const pilots = $derived(may('U', 'план', false) ? pilotNames() : [me.name]);
	const plannerReady = $derived(fleetModels().length > 0 && pilots.length > 0);

	/** Борт и пилот выбираются из справочников, поэтому варианты приходят из данных */
	const fields: Column[] = $derived(
		FLIGHT_FIELDS.map((f) =>
			f.key === 'aircraft'
				? { ...f, edit: 'select' as const, options: fleetModels() }
				: f.key === 'pilot'
					? { ...f, edit: 'select' as const, options: pilots }
					: f.key === 'checklist'
						? {
								// список зависит от выбранного борта: у него их может быть до трёх
								...f,
								edit: 'select' as const,
								options: (row: Row) =>
									listsFor(aircraftByModel(row.aircraft)?.id ?? '').map((c) => c.title)
							}
						: f
		)
	);

	const toolbar: TableAction[] = $derived<TableAction[]>([
		...(picked
			? [
					{
						key: 'all',
						label: 'Весь журнал',
						title: 'Снять отбор',
						onclick: () => goto('/flights')
					}
				]
			: []),
		...(may('C', 'план')
			? [
					{
						key: 'plan',
						label: 'Запланировать полёт',
						title: plannerReady ? undefined : 'Сначала добавьте БВС и сотрудника-пилота',
						icon: plane,
						tone: 'accent' as const,
						disabled: !plannerReady,
						onclick: () => {
							opened = blankFlight() ?? null;
							creating = true;
						}
					}
				]
			: [])
	]);

	/**
	 * Права на открытую карточку. В одном списке лежат и планы, и записи
	 * состоявшихся полётов, а права на них разные: план администратор правит
	 * и удаляет, запись — только правит, и удалить её не может никто
	 * (раздел 2.2). Пилот при этом распоряжается только своими (сноска ²).
	 */
	const plan = $derived(!opened || isPlanned(opened));
	const own = $derived(mine(opened ?? undefined));
	const elevated = $derived(me.roles.includes('владелец') || me.roles.includes('администратор'));
	// Пилот правит общий план команды, но только пока его статус именно
	// «запланирован». Переходы к выполнению — отдельные действия экрана полёта.
	const pilotMayEdit = $derived(opened?.status === 'запланирован' && may('U', 'план', own));
	const editable = $derived(
		creating ? may('C', 'план') : elevated ? may('U', plan ? 'план' : 'запись', own) : pilotMayEdit
	);
	const removable = $derived(
		!creating &&
			(elevated
				? may('D', plan ? 'план' : 'запись', own)
				: opened?.status === 'запланирован' && may('D', 'план', own))
	);

	function save(row: Row) {
		touched = saveFlight(row);
		close();
	}

	function remove(row: Row) {
		removeFlight(row.id);
		close();
	}

	function close() {
		opened = null;
		creating = false;
	}
</script>

<section class="w-full">
	<Table
		data={flights}
		columns={FLIGHT_COLUMNS}
		{toolbar}
		title={heading}
		focus={touched}
		defaultSort="date"
		{ranges}
		onrange={setRange}
		onselect={(row) => (opened = row as FlightRow)}
	/>

	<Modal
		show={opened !== null}
		row={opened ?? undefined}
		{fields}
		{creating}
		table
		title={creating ? 'Новый полёт' : opened ? `Полёт № ${opened.no}` : ''}
		onsave={editable ? save : undefined}
		ondelete={removable ? remove : undefined}
		onclose={close}
	>
		{#snippet field(row, column, editing)}
			{#if column.key === 'coords'}
				<!-- координаты хранятся числами и показываются в СППИ, а карта —
				     способ их прочитать и поставить точку (ФТ-5.4) -->
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
	</Modal>
</section>
