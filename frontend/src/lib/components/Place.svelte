<script lang="ts">
	import MapView from '$lib/components/MapView.svelte';
	import { hasPoint, parsePoint, type Row } from '$lib/components/format';
	import { addSite, nearestSite, siteByName } from '$lib/sites.svelte';

	/**
	 * Площадка записи: карта, ввод координат руками и заведение новой площадки
	 * в справочник (ФТ-5.4).
	 *
	 * Один компонент на учёт полётов и на планирование с телефона: экраны
	 * разные, а вопрос один — откуда взлетаем. Правит переданную запись
	 * по месту: это копия из карточки, сохранит её сама карточка.
	 */
	let { row, editing = false }: { row: Row; editing?: boolean } = $props();

	/** Что ввёл пилот руками; разбирается при потере фокуса и по Enter */
	let typed = $state('');
	let wrong = $state(false);
	/** Название для новой площадки: точку поставили там, где справочник пуст */
	let name = $state('');

	const known = $derived(hasPoint(row.lat, row.lon));
	/** Уже известная площадка в этой точке — заводить вторую такую же незачем */
	const near = $derived(known ? nearestSite(row.lat, row.lon) : undefined);
	const listed = $derived(!!near || !!siteByName(row.site));

	function place(lat: number, lon: number) {
		row.lat = lat;
		row.lon = lon;
		// попали в известную площадку — подставляем её название, чтобы запись
		// не осталась с координатами известного места и пустой строкой площадки
		const site = nearestSite(lat, lon);
		if (site) row.site = site.name;
	}

	function apply() {
		if (typed.trim() === '') {
			wrong = false;
			return;
		}
		const point = parsePoint(typed);
		wrong = !point;
		if (!point) return;
		place(point.lat, point.lon);
		typed = '';
	}

	function remember() {
		const value = name.trim();
		if (!value || !known) return;
		addSite(value, row.lat, row.lon);
		row.site = value;
		name = '';
	}
</script>

<div class="flex w-full flex-col gap-2">
	<!-- высота одна и та же в просмотре и в правке: переключение карточки
	     не должно менять размер карты — это лишний пересчёт ровно в тот момент,
	     когда пользователь и так меняет режим -->
	<MapView
		lat={row.lat}
		lon={row.lon}
		onpick={editing ? (p) => place(p.lat, p.lon) : undefined}
		height="14rem"
	/>

	{#if editing}
		<label class="flex flex-col gap-1">
			<span class="text-sm text-text-muted">Координаты вручную — СППИ или десятичные</span>
			<input
				bind:value={typed}
				class="min-h-0 rounded-sm px-2 py-1 text-sm"
				class:border-heat-bad={wrong}
				placeholder="571237N0652859E или 57.2104, 65.4831"
				onblur={apply}
				onkeydown={(e) => e.key === 'Enter' && apply()}
			/>
			{#if wrong}
				<span class="text-sm text-heat-bad">Не разобрал координаты — проверьте запись</span>
			{/if}
		</label>

		{#if known && !listed}
			<!-- точку поставили там, где площадки ещё нет: сохраняем в справочник,
			     чтобы в следующий раз её выбирали, а не набирали заново -->
			<div class="flex flex-wrap items-end gap-2">
				<label class="flex grow flex-col gap-1">
					<span class="text-sm text-text-muted">Новая площадка — название</span>
					<input
						bind:value={name}
						class="min-h-0 rounded-sm px-2 py-1 text-sm"
						placeholder="Поле у деревни Ушакова"
					/>
				</label>
				<button
					type="button"
					class="click min-h-0 cursor-pointer rounded-sm border border-accent bg-accent/15 px-3 py-1.5 text-sm text-accent disabled:opacity-40"
					disabled={name.trim() === ''}
					onclick={remember}
				>
					Сохранить площадку
				</button>
			</div>
		{/if}
	{/if}
</div>
