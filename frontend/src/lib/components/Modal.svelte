<script lang="ts">
	import type { Snippet } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { fade, scale } from 'svelte/transition';
	import Tag from '$lib/components/Tag.svelte';
	import apply_icon from '$lib/assets/apply.svg?raw';
	import close_icon from '$lib/assets/close.svg?raw';
	import pencil_icon from '$lib/assets/write.svg?raw';
	import trash_icon from '$lib/assets/delite.svg?raw';
	import undo_icon from '$lib/assets/undo.svg?raw';
	import {
		autoFields,
		cellText,
		TONE,
		type Column,
		type Row,
		type RowAction
	} from '$lib/components/format';

	/**
	 * Карточка записи: показывает строку таблицы целиком — включая поля,
	 * которых в списке нет (координаты, ссылки на борт и пилота), и позволяет
	 * их править. Действия над записью живут здесь, а не в столбце таблицы.
	 *
	 * Поля описываются тем же типом Column, что и столбцы, поэтому дата,
	 * продолжительность и статус выглядят одинаково в списке и в карточке.
	 * Правится только то, у чего задан edit; остальное — для чтения.
	 */
	let {
		show = $bindable(false),
		row,
		fields,
		title = '',
		actions = [],
		creating = false,
		table = false,
		onsave,
		ondelete,
		onclose,
		field,
		children
	}: {
		show?: boolean;
		/** Запись, которую показываем. Без неё в окне только children */
		row?: Row;
		/** Описание полей. Не передано — показываются все поля записи */
		fields?: Column[];
		title?: string;
		/** Дополнительные кнопки подвала помимо правки и удаления */
		actions?: RowAction[];
		/**
		 * Новая запись: карточка сразу открывается в правке, удалять нечего,
		 * а кнопка подтверждения называется «Добавить».
		 */
		creating?: boolean;
		/**
		 * Показывать поля таблицей «параметр — значение» с заголовками: длинная
		 * карточка так читается быстрее, чем набор подписей со значениями.
		 */
		table?: boolean;
		/** Задан — появляется «Изменить»; получает правленую копию записи */
		onsave?: (row: Row) => void;
		/** Задан — появляется «Удалить»; спрашивает подтверждение */
		ondelete?: (row: Row) => void;
		onclose?: () => void;
		/**
		 * Отрисовка полей с format: 'custom'. Третьим значением приходит признак
		 * правки: одно и то же поле показывают по-разному, когда его смотрят
		 * и когда меняют — карта против карты с выбором точки.
		 */
		field?: Snippet<[Row, Column, boolean]>;
		/** Произвольное содержимое под списком полей */
		children?: Snippet;
	} = $props();

	/** Поля с условием показываются только когда оно выполнено на правящейся записи */
	const list = $derived(
		(fields ?? (row ? autoFields(row) : [])).filter((f) => !f.when || f.when(draft ?? row ?? {}))
	);

	/** Черновик нового тега: одновременно правится одно поле-теги */
	let tagDraft = $state('');

	/** Варианты выпадающего списка: заданные, вычисленные от записи или из словаря */
	function options(f: Column, source: Row): string[] {
		const given = typeof f.options === 'function' ? f.options(source) : f.options;
		return given ?? Object.keys(f.levels ?? f.map ?? {});
	}

	function addTag(key: string, limit: number) {
		const value = tagDraft.trim();
		const tags = (draft?.[key] ?? []) as string[];
		if (!draft || !value || tags.includes(value) || tags.length >= limit) return;
		draft[key] = [...tags, value];
		tagDraft = '';
	}

	function dropTag(key: string, tag: string) {
		if (!draft) return;
		draft[key] = ((draft[key] ?? []) as string[]).filter((t) => t !== tag);
	}
	const extra = $derived(row ? actions.filter((a) => !a.hidden?.(row)) : []);

	/** Копия записи на время правки. null — режим просмотра */
	let draft = $state<Row | null>(null);
	/** Удаление в два шага: первый клик спрашивает, второй выполняет */
	let confirming = $state(false);

	// открыли другую запись — сбрасываем незаконченную правку и вопрос об удалении.
	// Новая запись открывается сразу в правке: смотреть в ней нечего
	$effect(() => {
		// обе величины читаются безусловно: при `creating && row` вычисление
		// обрывается на false, row не попадает в зависимости эффекта,
		// и следующее открытие карточки его уже не будит
		const source = row;
		const isNew = creating;
		draft = isNew && source ? { ...source } : null;
		confirming = false;
	});

	/** Длительность перехода: при отключённых в системе анимациях — мгновенно */
	const ms = (v: number) => (prefersReducedMotion.current ? 0 : v);

	const INPUT: Record<string, string> = {
		text: 'text',
		number: 'number',
		date: 'date',
		time: 'time'
	};

	const FIELD_CLASS = 'w-full rounded-sm px-2 py-1 text-sm';
	/** Кнопки шапки — только иконка, подпись уходит в подсказку и aria-label */
	const ICON_BTN = 'click min-h-0 cursor-pointer rounded-sm border p-1.5 [&_svg]:h-5 [&_svg]:w-5';

	function edit() {
		if (row) draft = { ...row };
	}

	function apply() {
		if (draft) onsave?.(draft);
		draft = null;
		close();
	}

	function remove() {
		if (!confirming) {
			confirming = true;
			return;
		}
		if (row) ondelete?.(row);
		close();
	}

	function close() {
		draft = null;
		confirming = false;
		// Когда страница задаёт show выражением (show={opened !== null}), закрывать
		// должна она: запись в проп из карточки перекрывает выражение локальным
		// значением, и следующее открытие может не сработать. Сами гасим show
		// только там, где его связали через bind: и обработчика закрытия нет.
		if (onclose) onclose();
		else show = false;
	}

	function onkeydown(e: KeyboardEvent) {
		if (show && e.key === 'Escape') close();
	}
</script>

<!-- значение поля: один и тот же вид и списком, и таблицей -->
{#snippet value(f: Column)}
	{@const src = (draft ?? row) as Row}
	{#if draft && f.edit === 'select'}
		{@const opts = options(f, draft)}
		<select bind:value={draft[f.key]} class={FIELD_CLASS}>
			{#each opts as opt (opt)}
				<option value={opt}>{f.map?.[opt] ?? opt}</option>
			{/each}
		</select>
	{:else if draft && f.edit}
		<!-- время вводится с секундами: по ним считается налёт (ФТ-10.3) -->
		<input
			type={INPUT[f.edit]}
			step={f.edit === 'time' ? 1 : undefined}
			bind:value={draft[f.key]}
			class={FIELD_CLASS}
		/>
	{:else if draft && f.format === 'notes'}
		<!-- примечания правятся построчно: одна строка — одно примечание -->
		<textarea
			rows="3"
			class={FIELD_CLASS}
			value={((draft[f.key] ?? []) as string[]).join('\n')}
			oninput={(e) =>
				draft &&
				(draft[f.key] = e.currentTarget.value
					.split('\n')
					.map((s) => s.trim())
					.filter(Boolean))}></textarea>
	{:else if f.format === 'custom'}
		{@render field?.(src, f, draft !== null)}
	{:else if f.format === 'tags'}
		{@const tags = (src[f.key] ?? []) as string[]}
		{@const limit = f.limit ?? 5}
		<div class="flex flex-wrap items-center gap-2">
			{#each tags as tag (tag)}
				<Tag level={f.locked?.includes(tag) ? 'info' : 'muted'}>
					{tag}
					{#if draft && !f.locked?.includes(tag)}
						<button
							type="button"
							class="click ml-1 min-h-0 cursor-pointer"
							aria-label="Убрать"
							onclick={() => dropTag(f.key, tag)}
						>
							×
						</button>
					{/if}
				</Tag>
			{:else}
				{#if !draft}<span class="text-text-muted">—</span>{/if}
			{/each}

			{#if draft && tags.length < limit}
				{@const rest = options(f, draft).filter((o) => !tags.includes(o))}
				{#if f.options}
					<!-- набор закрыт (роли): выбирают из оставшегося, а не набирают -->
					{#if rest.length > 0}
						<select
							class="min-h-0 rounded-sm px-2 py-1 text-sm"
							value=""
							onchange={(e) => {
								tagDraft = e.currentTarget.value;
								addTag(f.key, limit);
								e.currentTarget.value = '';
							}}
						>
							<option value="" disabled>Добавить…</option>
							{#each rest as opt (opt)}
								<option value={opt}>{f.map?.[opt] ?? opt}</option>
							{/each}
						</select>
					{/if}
				{:else}
					<input
						bind:value={tagDraft}
						class="min-h-0 rounded-sm px-2 py-1 text-sm"
						placeholder="Новый тег"
						onkeydown={(e) => e.key === 'Enter' && addTag(f.key, limit)}
					/>
					<button
						type="button"
						class="click min-h-0 cursor-pointer rounded-sm border px-2 py-1 text-sm text-text-muted"
						onclick={() => addTag(f.key, limit)}
					>
						Добавить
					</button>
				{/if}
			{/if}
		</div>
	{:else if f.format === 'notes'}
		{@const notes = (src[f.key] ?? []) as string[]}
		{#if notes.length > 0}
			<!-- в списке была цифра; здесь примечания и читают -->
			<ul class="flex flex-col gap-1">
				{#each notes as note}
					<li class="before:text-text-muted before:content-['—_']">{note}</li>
				{/each}
			</ul>
		{:else}
			<span class="text-text-muted">—</span>
		{/if}
	{:else if f.format === 'status'}
		{@const value = String(src[f.key])}
		<Tag level={f.level?.(src) ?? f.levels?.[value] ?? 'muted'}>{value}</Tag>
	{:else}
		{cellText(src, f)}
	{/if}
{/snippet}

<svelte:window {onkeydown} />

{#if show}
	<!-- подложка кнопкой, а не div с onclick: так закрытие доступно с клавиатуры -->
	<button
		type="button"
		class="fixed inset-0 z-40 cursor-default bg-black/60"
		aria-label="Закрыть карточку"
		transition:fade={{ duration: ms(120) }}
		onclick={close}
	></button>

	<div
		class="fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[min(44rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border bg-front p-6"
		role="dialog"
		aria-modal="true"
		aria-label={title || 'Карточка записи'}
		transition:scale={{ duration: ms(140), start: 0.98, opacity: 0 }}
	>
		<header class="flex items-start justify-between gap-4">
			<h2 class="text-2xl">{title}</h2>

			<div class="flex items-center gap-2">
				{#if row}
					{#if draft}
						<button
							type="button"
							class="{ICON_BTN} {TONE.default}"
							title="Отмена"
							aria-label="Отмена"
							onclick={() => (creating ? close() : (draft = null))}
						>
							{@html undo_icon}
						</button>
						<button
							type="button"
							class="{ICON_BTN} {TONE.accent}"
							title={creating ? 'Добавить' : 'Применить'}
							aria-label={creating ? 'Добавить' : 'Применить'}
							onclick={apply}
						>
							{@html apply_icon}
						</button>
					{:else}
						{#each creating ? [] : extra as a (a.key)}
							<button
								type="button"
								class="{ICON_BTN} {TONE[
									a.tone ?? 'default'
								]} disabled:cursor-not-allowed disabled:opacity-40"
								title={a.title ?? a.label}
								aria-label={a.label}
								disabled={a.disabled?.(row) ?? false}
								onclick={() => {
									a.onclick(row);
									close();
								}}
							>
								{@html a.icon ?? ''}
							</button>
						{/each}

						{#if onsave}
							<button
								type="button"
								class="{ICON_BTN} {TONE.accent}"
								title="Изменить"
								aria-label="Изменить"
								onclick={edit}
							>
								{@html pencil_icon}
							</button>
						{/if}

						{#if ondelete && !creating}
							<!-- удаление в два шага: на подтверждении к иконке добавляется подпись -->
							<button
								type="button"
								class="{ICON_BTN} {TONE.danger} inline-flex items-center gap-2"
								title={confirming ? 'Точно удалить?' : 'Удалить'}
								aria-label={confirming ? 'Точно удалить?' : 'Удалить'}
								onclick={remove}
							>
								{@html trash_icon}
								{#if confirming}<span class="text-sm">Точно удалить?</span>{/if}
							</button>
						{/if}
					{/if}
				{/if}

				<button
					type="button"
					class="{ICON_BTN} text-text-muted"
					aria-label="Закрыть"
					title="Закрыть"
					onclick={close}
				>
					{@html close_icon}
				</button>
			</div>
		</header>

		{#if row && list.length > 0}
			{#if table}
				<!-- две колонки с заголовками: подробности читаются как строки
				     таблицы, а не как подписи к полям -->
				<table class="w-full table-fixed text-sm">
					<thead>
						<tr class="border-b text-left text-text-muted">
							<th class="w-[clamp(7rem,30%,13rem)] py-2 font-normal">Параметр</th>
							<th class="py-2 font-normal">Значение</th>
						</tr>
					</thead>
					<tbody>
						{#each list as f (f.key)}
							<tr class="border-b align-middle last:border-b-0">
								<td class="py-2 pr-4 text-text-muted">{f.title}</td>
								<!-- min-w-0 не даёт широкому содержимому (карте) раздвинуть окно -->
								<td class="min-w-0 py-2" class:tabular-nums={f.num}>{@render value(f)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<dl class="grid grid-cols-[minmax(7rem,13rem)_1fr] items-center gap-x-6 gap-y-2 text-sm">
					{#each list as f (f.key)}
						<dt class="text-text-muted">{f.title}</dt>
						<dd class="min-w-0" class:tabular-nums={f.num}>{@render value(f)}</dd>
					{/each}
				</dl>
			{/if}
		{/if}

		{@render children?.()}
	</div>
{/if}
