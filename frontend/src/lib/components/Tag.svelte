<script lang="ts">
	import { tagStyle, type StatusLevel } from '$lib/components/format';
	import type { Snippet } from 'svelte';

	/**
	 * Плашка состояния: годность борта, статус полёта, износ батареи, ответ
	 * в чеклисте.
	 *
	 * Раньше её собирали на месте из строки классов и функции цвета — в восьми
	 * файлах, и плашки уже начали расходиться размером. Теперь оформление
	 * в одном месте, а снаружи задаётся только смысл: уровень и содержимое.
	 *
	 * Цвет по-прежнему не единственный признак: то, что означает плашка,
	 * написано в ней словами, а уровень лишь подкрашивает.
	 */
	let {
		level = 'muted',
		size = 'sm',
		title = '',
		onclick,
		children
	}: {
		level?: StatusLevel;
		/**
		 * Размер: 'sm' — в таблицах и карточках, 'md' — в шапке приложения,
		 * где плашка стоит рядом с кнопками меню и обязана быть с них ростом.
		 */
		size?: 'sm' | 'md';
		title?: string;
		/** Задан — плашка становится кнопкой: по ней открывают связанное с ней */
		onclick?: () => void;
		children?: Snippet;
	} = $props();

	const BASE = 'inline-flex items-center whitespace-nowrap rounded-sm';
	const SIZE = { sm: 'px-2 py-0.5 text-xs', md: 'p-1.5' };
</script>

{#if onclick}
	<button
		type="button"
		class="{BASE} {SIZE[size]} click min-h-0 cursor-pointer"
		style={tagStyle(level)}
		{title}
		{onclick}
	>
		{@render children?.()}
	</button>
{:else}
	<span class="{BASE} {SIZE[size]}" style={tagStyle(level)} {title}>
		{@render children?.()}
	</span>
{/if}
