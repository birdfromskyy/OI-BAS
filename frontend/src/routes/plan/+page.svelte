<script lang="ts">
	import Modal from '$lib/components/Modal.svelte';
	import Place from '$lib/components/Place.svelte';
	import Planned from '$lib/components/Planned.svelte';
	import type { Column, Row } from '$lib/components/format';
	import { FLIGHT_FIELDS } from '$lib/components/columns';
	import { blankFlight, saveFlight } from '$lib/flights.svelte';
	import type { FlightRow } from '$lib/mocs/rows';
	import { aircraftByModel, fleetModels } from '$lib/fleet.svelte';
	import { listsFor } from '$lib/checklists.svelte';
	import { pilotNames } from '$lib/staff.svelte';
	import { may, me } from '$lib/session.svelte';

	/** Планируемые полёты на телефоне: список и создание плана на месте (ФТ-15.3) */
	let opened = $state<FlightRow | null>(null);

	/**
	 * Кого можно поставить пилотом. Пилот планирует только за себя (сноска ²
	 * матрицы 2.2), поэтому выбор ему не нужен; администратор планирует за
	 * любого — у него в списке весь штат.
	 */
	const pilots = $derived(may('U', 'план', false) ? pilotNames() : [me.name]);
	const plannerReady = $derived(fleetModels().length > 0 && pilots.length > 0);

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

	function save(row: Row) {
		saveFlight(row);
		opened = null;
	}
</script>

<section class="mx-auto flex w-full max-w-2xl flex-col gap-3">
	{#if may('C', 'план')}
		<!-- планирует пилот; техник и наблюдатель приходят сюда только смотреть -->
		<button
			class="click min-h-touch rounded-lg border border-accent bg-accent/15 p-3 text-lg text-accent disabled:cursor-not-allowed disabled:opacity-40"
			disabled={!plannerReady}
			title={plannerReady ? undefined : 'Сначала добавьте БВС и сотрудника-пилота'}
			onclick={() => (opened = blankFlight() ?? null)}
		>
			Запланировать полёт
		</button>
	{/if}

	<Planned />
</section>

<Modal
	show={opened !== null}
	row={opened ?? undefined}
	{fields}
	creating
	table
	title="Новый полёт"
	onsave={save}
	onclose={() => (opened = null)}
>
	{#snippet field(row, column, editing)}
		{#if column.key === 'coords'}
			<!-- площадку выбирают на месте: карта и координаты руками (ФТ-5.4) -->
			<Place {row} {editing} />
		{/if}
	{/snippet}
</Modal>
