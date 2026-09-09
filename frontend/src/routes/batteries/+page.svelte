<script lang="ts">
	import Table from '$lib/components/Table.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Tag from '$lib/components/Tag.svelte';
	import { showDate, type Row, type TableAction } from '$lib/components/format';
	import plus from '$lib/assets/plus.svg?raw';
	import { BATTERY_COLUMNS, BATTERY_FIELDS } from '$lib/components/columns';
	import type { Battery } from '$lib/mocs/batteries';
	import { may } from '$lib/session.svelte';
	import {
		batteries,
		nextBatteryId,
		removeBattery,
		saveBattery,
		wear,
		wearLevel,
		WEAR_CRITICAL,
		WEAR_WARNING
	} from '$lib/batteries.svelte';

	/**
	 * Учёт аккумуляторов (ФТ-11).
	 *
	 * Батарея принадлежит парку, а не борту, поэтому список свой, а не колонка
	 * в карточке БВС. Состояние определяется не сроком службы, а тем, что она
	 * отдаёт под нагрузкой: измеренные ёмкость и токоотдача стоят рядом
	 * с паспортными, а износ считается по худшему из двух.
	 */
	let opened = $state<Battery | null>(null);
	let creating = $state(false);
	/** Последняя добавленная или изменённая запись — таблица покажет её страницу */
	let touched = $state<string>();

	/** Износ приходит в строке полем: по нему таблица сортирует и красит */
	const rows = $derived(batteries.map((b) => ({ ...b, wear: wear(b) })));

	const toolbar: TableAction[] = $derived(
		may('C', 'аккумуляторы')
			? [
					{
						key: 'add',
						label: 'Добавить аккумулятор',
						icon: plus,
						tone: 'accent' as const,
						onclick: () => {
							opened = blank();
							creating = true;
						}
					}
				]
			: []
	);

	/** Заготовка: паспортные значения вводит администратор, измеренные — после проверки */
	function blank(): Battery {
		const today = new Date().toISOString().slice(0, 10);
		return {
			id: nextBatteryId(),
			serial: '',
			status: 'в строю',
			started: today,
			checked: today,
			checkedAt: '',
			capacity: 0,
			capacityNow: 0,
			output: 0,
			outputNow: 0,
			note: ''
		};
	}

	function save(row: Row) {
		const updated = row as Battery;
		saveBattery(updated);
		touched = updated.id;
		close();
	}

	function remove(row: Row) {
		removeBattery(row.id);
		close();
	}

	function close() {
		opened = null;
		creating = false;
	}
</script>

<section class="w-full">
	<Table
		data={rows}
		columns={BATTERY_COLUMNS}
		{toolbar}
		title="Аккумуляторы"
		focus={touched}
		defaultSort="wear"
		defaultAsc
		onselect={(row) => (opened = row as Battery)}
	>
		{#snippet cell(row, column)}
			{#if column.key === 'checked'}
				<!-- дата и время проверки вместе: это один момент, а не два параметра -->
				<span class="tabular-nums">
					{showDate(row.checked)}
					{#if row.checkedAt}<span class="text-text-muted">{row.checkedAt}</span>{/if}
				</span>
			{:else if column.key === 'wear'}
				<!-- износ плашкой: столбец из одних чисел читается сравнением,
				     а цвет сразу говорит, какие батареи требуют внимания.
				     Знак процента в каждой строке не нужен — он в названии
				     столбца, а словами величина расшифрована в подсказке -->
				<Tag level={wearLevel(row.wear)} title="{row.wear} % от паспортных значений">
					{row.wear}
				</Tag>
			{/if}
		{/snippet}
	</Table>

	<Modal
		show={opened !== null}
		row={opened ?? undefined}
		fields={BATTERY_FIELDS}
		{creating}
		table
		title={creating ? 'Новый аккумулятор' : (opened?.serial ?? '')}
		onsave={may('U', 'аккумуляторы') ? save : undefined}
		ondelete={may('D', 'аккумуляторы') ? remove : undefined}
		onclose={close}
	>
		{#if opened && !creating}
			{@const percent = wear(opened)}
			<p class="border-t pt-4 text-sm text-text-muted">
				Батарея отдаёт {percent} % от паспорта — считаем по худшему из двух показателей, ёмкости и токоотдачи.
				{#if percent < WEAR_CRITICAL}
					Ниже {WEAR_CRITICAL} % к полётам не допускается.
				{:else if percent < WEAR_WARNING}
					Ниже {WEAR_WARNING} % требует внимания: проверять чаще и не брать на длинные задачи.
				{/if}
			</p>
		{/if}
	</Modal>
</section>
