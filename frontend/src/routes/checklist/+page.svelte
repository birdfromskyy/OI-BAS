<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Modal from '$lib/components/Modal.svelte';
	import Table from '$lib/components/Table.svelte';
	import { showDate, type Row, type TableAction } from '$lib/components/format';
	import { ITEM_COLUMNS, ITEM_FIELDS } from '$lib/components/columns';
	import plus from '$lib/assets/plus.svg?raw';
	import {
		blankItem,
		createFor,
		listsFor,
		MAX_PER_AIRCRAFT,
		moveItem,
		removeChecklist,
		removeItem,
		renameChecklist,
		templateFor,
		upsertItem
	} from '$lib/checklists.svelte';
	import type { ChecklistItem } from '$lib/mocs/checklists';
	import { aircraftById } from '$lib/fleet.svelte';
	import { may } from '$lib/session.svelte';
	import { retitleChecklist } from '$lib/flights.svelte';

	/**
	 * Редактор чеклиста борта (ФТ-4.1–4.10). Открывается из карточки в парке БВС.
	 *
	 * Пункты показываются той же таблицей, что и остальные списки, но порядок
	 * в них ручной: пилот идёт по чеклисту сверху вниз. Поэтому строки двигают
	 * стрелками, а таблица по умолчанию отсортирована по номеру по возрастанию.
	 */
	const aircraft = $derived(aircraftById(page.url.searchParams.get('aircraft') ?? ''));
	/** Все чеклисты борта: их может быть до трёх */
	const own = $derived(aircraft ? listsFor(aircraft.id) : []);
	/** Открытый на правку — из адреса, иначе первый */
	const list = $derived(own.find((c) => c.id === page.url.searchParams.get('list')) ?? own[0]);
	const template = $derived(aircraft ? templateFor(aircraft.model) : undefined);

	/** Номер строки хранится в данных: по нему таблица держит ручной порядок */
	const rows = $derived((list?.items ?? []).map((item, i) => ({ ...item, pos: i + 1 })));

	let opened = $state<ChecklistItem | null>(null);
	let creating = $state(false);
	let confirmingDelete = $state(false);

	/**
	 * Редактор чеклиста открыт администратору и технику (ФТ-4.4). Остальным
	 * чеклист показывается на чтение: пилоту важно видеть, по чему его проверят,
	 * но правит его не он.
	 */
	const editable = $derived(may('U', 'чеклист'));

	const toolbar: TableAction[] = $derived(
		editable
			? [
					{
						key: 'add',
						label: 'Добавить пункт',
						icon: plus,
						tone: 'accent',
						onclick: () => {
							if (!list) return;
							opened = blankItem(list);
							creating = true;
						}
					}
				]
			: []
	);

	/**
	 * Черновик названия. Правится в поле, применяется кнопкой: переименование
	 * поднимает версию чеклиста (ФТ-4.10), и делать это на каждую нажатую
	 * букву нельзя — история превратилась бы в свалку версий.
	 */
	let name = $state('');
	let renameError = $state('');

	// открыли другой чеклист — в поле его название
	$effect(() => {
		name = list?.title ?? '';
		renameError = '';
		confirmingDelete = false;
	});

	function rename() {
		if (!list) return;
		const was = list.title;
		renameError = renameChecklist(list, name);
		if (renameError) return;
		// планы, выбравшие этот чеклист по имени, должны догнать новое (ФТ-5.2)
		retitleChecklist(list.aircraftId, was, list.title);
		name = list.title;
	}

	function save(row: Row) {
		if (list) upsertItem(list, { ...row, pos: undefined });
		close();
	}

	function drop(row: Row) {
		if (list) removeItem(list, row.id);
		close();
	}

	function close() {
		opened = null;
		creating = false;
	}

	function removeList() {
		if (!list || !aircraft) return;
		if (!confirmingDelete) {
			confirmingDelete = true;
			return;
		}
		removeChecklist(list.id);
		confirmingDelete = false;
		goto(`/checklist?aircraft=${aircraft.id}`);
	}
</script>

<section class="flex w-full flex-col gap-4">
	{#if !aircraft}
		<p class="py-8 text-center text-text-muted">Борт не найден</p>
	{:else if !list}
		<div class="flex flex-col items-center gap-4 rounded-lg border bg-front p-8">
			<p class="text-text-muted">У борта {aircraft.model} нет своего чеклиста</p>
			<div class="flex gap-2" class:hidden={!may('C', 'чеклист')}>
				{#if template}
					<!-- копия шаблона правится независимо и другие борта не трогает (ФТ-4.3) -->
					<button
						class="click min-h-0 rounded-sm border border-accent bg-accent/15 px-3 py-1.5 text-accent"
						onclick={() => createFor(aircraft, true)}
					>
						Создать из шаблона модели
					</button>
				{/if}
				<button
					class="click min-h-0 rounded-sm border px-3 py-1.5 text-text-muted"
					onclick={() => createFor(aircraft, false)}
				>
					Создать пустой
				</button>
			</div>
		</div>
	{:else}
		<header class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex flex-wrap items-center gap-2">
				<!-- у борта до трёх чеклистов: короткий на перелёт, полный на съёмку и так далее -->
				{#each own as c (c.id)}
					<a
						href="/checklist?aircraft={aircraft.id}&list={c.id}"
						class={[
							'click rounded-sm border px-3 py-1.5 text-sm',
							c.id === list.id ? 'border-accent bg-accent/15 text-accent' : 'text-text-muted'
						]}
					>
						{c.title}
					</a>
				{/each}

				{#if own.length < MAX_PER_AIRCRAFT && may('C', 'чеклист')}
					<button
						class="click min-h-0 rounded-sm border px-3 py-1.5 text-sm text-text-muted"
						onclick={() => aircraft && createFor(aircraft, false)}
					>
						+ Чеклист
					</button>
				{/if}
			</div>

			<a href="/BVS" class="click min-h-0 rounded-sm border px-3 py-1.5 text-sm text-text-muted">
				К парку
			</a>
		</header>

		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex grow flex-col gap-1">
				<label class="flex items-center gap-3">
					<span class="text-sm text-text-muted">Название</span>
					<!-- название отличает чеклисты борта друг от друга: по нему его выбирают
					     в плане полёта, поэтому переименование — явное действие с проверкой -->
					<input
						bind:value={name}
						class="min-h-0 grow rounded-sm px-2 py-1"
						readonly={!editable}
						onkeydown={(e) => e.key === 'Enter' && rename()}
					/>
					{#if editable}
						<button
							type="button"
							class="click min-h-0 shrink-0 cursor-pointer rounded-sm border border-accent bg-accent/15 px-3 py-1.5 text-sm text-accent disabled:opacity-40"
							disabled={name.trim() === '' || name.trim() === list.title}
							onclick={rename}
						>
							Переименовать
						</button>
					{/if}
				</label>
				{#if renameError}
					<span class="text-sm text-heat-bad">{renameError}</span>
				{/if}
			</div>
			<p class="text-sm text-text-muted">
				Версия {list.version} · изменён {showDate(list.updated)} · {list.author}
			</p>
			{#if may('D', 'чеклист')}
				<button
					type="button"
					class="click min-h-0 shrink-0 rounded-sm border border-heat-bad px-3 py-1.5 text-sm text-heat-bad"
					onclick={removeList}
				>
					{confirmingDelete ? 'Точно удалить чеклист?' : 'Удалить чеклист'}
				</button>
			{/if}
		</div>

		<Table
			data={rows}
			columns={ITEM_COLUMNS}
			{toolbar}
			title={aircraft.model}
			defaultSort="pos"
			defaultAsc
			onselect={(row) => (opened = row as ChecklistItem)}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'order' && editable}
					<!-- порядок меняется здесь же: открывать карточку ради перестановки незачем -->
					<div class="flex justify-end gap-1">
						<button
							type="button"
							class="click min-h-0 cursor-pointer rounded-sm border px-2 py-1 text-xs text-text-muted disabled:opacity-30"
							aria-label="Выше"
							disabled={row.pos === 1}
							onclick={(e) => {
								e.stopPropagation();
								if (list) moveItem(list, row.id, -1);
							}}
						>
							↑
						</button>
						<button
							type="button"
							class="click min-h-0 cursor-pointer rounded-sm border px-2 py-1 text-xs text-text-muted disabled:opacity-30"
							aria-label="Ниже"
							disabled={row.pos === rows.length}
							onclick={(e) => {
								e.stopPropagation();
								if (list) moveItem(list, row.id, 1);
							}}
						>
							↓
						</button>
					</div>
				{/if}
			{/snippet}
		</Table>
	{/if}
</section>

<Modal
	show={opened !== null}
	row={opened ?? undefined}
	fields={ITEM_FIELDS}
	{creating}
	table
	title={creating ? 'Новый пункт' : (opened?.title ?? '')}
	onsave={editable ? save : undefined}
	ondelete={editable ? drop : undefined}
	onclose={close}
/>
