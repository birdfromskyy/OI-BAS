<script lang="ts">
	import { goto } from '$app/navigation';
	import Tag from '$lib/components/Tag.svelte';
	import type { StatusLevel } from '$lib/components/format';
	import { flights, isActive } from '$lib/flights.svelte';

	/**
	 * Ближайшие планируемые полёты (ФТ-15.3) — карточками, а не таблицей.
	 *
	 * Список один на два экрана: с телефона это главный экран пилота,
	 * на панели администратора — ячейка рядом с диаграммами. Поэтому карточка
	 * вынесена в компонент, а не повторяется в обеих страницах.
	 */
	let { limit = 0 }: { limit?: number } = $props();

	const planned = $derived.by(() => {
		const rows = flights
			.filter(isActive)
			.sort((a, b) => (a.date + a.takeoff).localeCompare(b.date + b.takeoff));
		return limit > 0 ? rows.slice(0, limit) : rows;
	});

	const LEVEL: Record<string, StatusLevel> = {
		черновик: 'muted',
		запланирован: 'info',
		'подготовка пройдена': 'ok',
		// борт уже в воздухе: состояние, а не предупреждение
		выполняется: 'live'
	};
</script>

<div class="flex flex-col gap-3">
	{#each planned as flight (flight.id)}
		<!-- карточка целиком кликабельна: попасть пальцем в перчатке проще, чем в ссылку -->
		<button
			class="click flex min-h-touch flex-col gap-2 rounded-lg border bg-front p-4 text-left"
			onclick={() => goto(`/list?flight=${flight.id}`)}
		>
			<!-- сверху вниз: на чём летим и в каком это состоянии, кто летит,
			     зачем. Время и площадка в карточку не идут: список короткий,
			     а подробности открываются нажатием -->
			<span class="flex w-full items-center justify-between gap-3">
				<span class="text-lg">{flight.aircraft}</span>
				<Tag level={LEVEL[flight.status] ?? 'muted'}>{flight.status}</Tag>
			</span>

			<span class="text-text-muted">{flight.pilot || 'пилот не назначен'}</span>
			<span class="text-text-muted">{flight.task || 'задача не задана'}</span>
		</button>
	{:else}
		<p class="py-8 text-center text-text-muted">Запланированных полётов нет</p>
	{/each}
</div>
