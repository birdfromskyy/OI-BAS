<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Листание страницами: стрелки, номера и многоточия вместо середины.
	 *
	 * Жил в таблице, а понадобился и календарю — год там выбирают тем же
	 * движением, что и страницу в журнале. Второй такой же набор кнопок
	 * рядом разошёлся бы с первым при первой же правке, поэтому листание
	 * вынесено сюда, а снаружи задаётся только смысл: сколько страниц,
	 * какая открыта и как она называется.
	 */
	let {
		page,
		count,
		onchange,
		label,
		back = 'Предыдущая страница',
		forward = 'Следующая страница',
		title = 'Страницы',
		children
	}: {
		/** Открытая страница, считая с единицы */
		page: number;
		/** Сколько всего страниц. Одна — листать нечего, остаются только children */
		count: number;
		onchange: (page: number) => void;
		/**
		 * Что написать на кнопке. Не задано — номер страницы; календарю нужен
		 * год, а не порядковый номер, и подпись он задаёт сам.
		 */
		label?: (page: number) => string | number;
		/** Подписи стрелок для читалки экрана: у страницы и года разный род */
		back?: string;
		forward?: string;
		title?: string;
		/** Что стоит слева от листания: выгрузка таблицы, счётчик строк */
		children?: Snippet;
	} = $props();

	/**
	 * Номера страниц с многоточиями: 1 … 4 5 6 … 12.
	 * null — место пропуска.
	 */
	const pages = $derived.by(() => {
		if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
		const near = [page - 1, page, page + 1].filter((p) => p > 1 && p < count);
		const out: (number | null)[] = [1];
		if (near[0] > 2) out.push(null);
		out.push(...near);
		if (near[near.length - 1] < count - 1) out.push(null);
		out.push(count);
		return out;
	});

	const name = (p: number) => label?.(p) ?? p;
</script>

<nav class="flex items-center justify-end gap-1 text-sm" aria-label={title}>
	{@render children?.()}

	{#if count > 1}
		<button
			type="button"
			class="click min-h-0 cursor-pointer rounded-sm border px-2 py-1 text-text-muted disabled:cursor-not-allowed disabled:opacity-40"
			aria-label={back}
			disabled={page === 1}
			onclick={() => onchange(page - 1)}
		>
			‹
		</button>

		{#each pages as p, i (i)}
			{#if p === null}
				<span class="px-1 text-text-muted">…</span>
			{:else}
				<button
					type="button"
					class="min-h-0 min-w-8 cursor-pointer rounded-sm border px-2 py-1 tabular-nums {p === page
						? 'border-accent bg-accent/15 text-accent'
						: 'text-text-muted hover:text-text'}"
					aria-current={p === page ? 'page' : undefined}
					onclick={() => onchange(p)}
				>
					{name(p)}
				</button>
			{/if}
		{/each}

		<button
			type="button"
			class="click min-h-0 cursor-pointer rounded-sm border px-2 py-1 text-text-muted disabled:cursor-not-allowed disabled:opacity-40"
			aria-label={forward}
			disabled={page === count}
			onclick={() => onchange(page + 1)}
		>
			›
		</button>
	{/if}
</nav>
