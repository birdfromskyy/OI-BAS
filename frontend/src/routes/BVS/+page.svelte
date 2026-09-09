<script lang="ts">
	import Table from '$lib/components/Table.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Modal from '$lib/components/Modal.svelte';
	import Tag from '$lib/components/Tag.svelte';
	import {
		hours,
		type Column,
		type Row,
		type RowAction,
		type TableAction
	} from '$lib/components/format';
	import clipboard from '$lib/assets/check.svg?raw';
	import drone from '$lib/assets/drone.svg?raw';
	import { FLEET_COLUMNS, FLEET_FIELDS } from '$lib/components/columns';
	import type { Aircraft } from '$lib/mocs/fleet';
	import { may } from '$lib/session.svelte';
	import {
		fleet,
		nextAircraftId,
		removeAircraft,
		saveAircraft,
		untilService
	} from '$lib/fleet.svelte';

	let opened = $state<Aircraft | null>(null);

	/**
	 * Карточка борта открывается адресом /BVS?aircraft=<id>: с панели так
	 * переходят к борту с просроченным ТО (ФТ-15.13).
	 */
	let fromLink = $state('');
	$effect(() => {
		const id = page.url.searchParams.get('aircraft') ?? '';
		if (!id || id === fromLink) return;
		fromLink = id;
		opened = fleet.find((a) => a.id === id) ?? null;
	});
	let creating = $state(false);
	/** Последняя добавленная или изменённая запись — таблица покажет её страницу */
	let touched = $state<string>();

	/** Борта заводит администратор (раздел 2.2); техник только правит состояние */
	const toolbar: TableAction[] = $derived(
		may('C', 'борт')
			? [
					{
						key: 'add',
						label: 'Добавить БВС',
						icon: drone,
						tone: 'accent',
						onclick: () => {
							opened = blank();
							creating = true;
						}
					}
				]
			: []
	);

	/**
	 * Учётный номер и регистрационные данные технику закрыты (сноска ¹ матрицы):
	 * он отвечает за состояние борта, а не за его регистрацию. Поле остаётся
	 * в карточке, но без правки — видеть номер нужно всем.
	 */
	const fields: Column[] = $derived(
		FLEET_FIELDS.map((f) =>
			f.key === 'reg' && !may('U', 'регистрация') ? { ...f, edit: undefined } : f
		)
	);

	/** Действие сверх правки и удаления — у парка своё */
	const actions: RowAction[] = [
		{
			key: 'checklist',
			label: 'Чеклист',
			icon: clipboard,
			onclick: (row) => goto(`/checklist?aircraft=${row.id}`)
		}
	];

	/** Заготовка борта: наработка нулевая, она наберётся из журнала (ФТ-3.4) */
	function blank(): Aircraft {
		return {
			id: nextAircraftId(),
			model: '',
			reg: '',
			status: 'годен',
			hours: 0,
			flights: 0,
			service: 0,
			serviced: 0
		};
	}

	function save(row: Row) {
		const updated = row as Aircraft;
		saveAircraft(updated);
		touched = updated.id;
		close();
	}

	function remove(row: Row) {
		removeAircraft(row.id);
		close();
	}

	function close() {
		opened = null;
		creating = false;
	}
</script>

<!-- остаток ресурса числом: его читают, сравнивая борта между собой, а слова
     «до ТО» в каждой строке этому только мешают. Ответ здесь один из двух —
     ресурс есть или регламент вышел, — и цвет плашки его и даёт. Словами то же
     самое в подсказке. Сниппет один на таблицу и карточку: величина одна,
     и выглядеть в двух местах по-разному она не должна -->
{#snippet resource(row: Row)}
	{@const left = untilService(row as Aircraft)}
	{#if left === undefined}
		<span class="text-text-muted">регламент не задан</span>
	{:else}
		<Tag
			level={left > 0 ? 'ok' : 'bad'}
			title={left > 0 ? `${hours(left)} до регламентного ТО` : `просрочено на ${hours(-left)}`}
		>
			{hours(Math.abs(left))}
		</Tag>
	{/if}
{/snippet}

<section class="w-full">
	<Table
		data={fleet}
		columns={FLEET_COLUMNS}
		{toolbar}
		title="Парк БВС"
		focus={touched}
		defaultSort="flights"
		onselect={(row) => (opened = row as Aircraft)}
	>
		{#snippet cell(row)}
			{@render resource(row)}
		{/snippet}
	</Table>

	<Modal
		show={opened !== null}
		row={opened ?? undefined}
		{fields}
		{creating}
		table
		title={creating ? 'Новый борт' : (opened?.model ?? '')}
		{actions}
		onsave={may('U', 'борт') ? save : undefined}
		ondelete={may('D', 'борт') ? remove : undefined}
		onclose={close}
	>
		{#snippet field(row)}
			{@render resource(row)}
		{/snippet}
	</Modal>
</section>
