import type { Slice } from '$lib/components/Diagram.svelte';
import type { Row } from '$lib/components/format';
import { isFlown } from '$lib/flights.svelte';

/**
 * Сбор данных круговых диаграмм из журнала полётов (ФТ-15.4, ФТ-15.5, ФТ-15.7).
 *
 * Считаются состоявшиеся полёты: план и черновик — намерение, а не работа,
 * и в распределении по бортам и пилотам им не место.
 *
 * У каждой доли две величины: число вылетов и налёт. Это разные картины —
 * борт может летать чаще всех короткими подлётами, а часы набирать другой, —
 * поэтому диаграмма умеет показывать обе, а не выбирать за пользователя.
 */

function groupBy(flights: Row[], key: string): Slice[] {
	const count = new Map<string, number>();
	const seconds = new Map<string, number>();

	for (const f of flights) {
		if (!isFlown(f)) continue;
		const label = String(f[key] ?? '').trim();
		if (!label) continue;
		count.set(label, (count.get(label) ?? 0) + 1);
		seconds.set(label, (seconds.get(label) ?? 0) + (Number(f.duration) || 0));
	}

	return [...count.entries()]
		.map(([label, value]) => ({ label, value, extra: seconds.get(label) ?? 0 }))
		.sort((a, b) => b.value - a.value);
}

/** Полёты и налёт по бортам */
export function flightsByAircraft(flights: Row[]): Slice[] {
	return groupBy(flights, 'aircraft');
}

/** Полёты и налёт по пилотам */
export function flightsByPilot(flights: Row[]): Slice[] {
	return groupBy(flights, 'pilot');
}
