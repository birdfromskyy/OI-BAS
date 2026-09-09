import { persist } from '$lib/storage.svelte';
import type { Aircraft } from '$lib/mocs/fleet';
import { enqueue } from '$lib/sync.svelte';
import { uuid } from '$lib/api';

/**
 * Парк БВС (ФТ-3).
 *
 * Живёт на устройстве, как штат и площадки: борта заводит администратор,
 * а читают их все экраны — планирование, чеклисты, дашборд, — и правка,
 * не пережившая перезагрузку, не правка.
 */
// Данные приходят из API или сохранённого офлайн-кэша устройства. У новой
// компании не должны появляться демонстрационные борта.
export const fleet = persist<Aircraft>('fleet', []);

export function aircraftById(id: string): Aircraft | undefined {
	return fleet.find((a) => a.id === id);
}

export function aircraftByModel(model: string): Aircraft | undefined {
	return fleet.find((a) => a.model === model);
}

/** Названия для выбора борта в карточке полёта */
export function fleetModels(): string[] {
	return fleet.map((a) => a.model);
}

/** Следующий свободный номер борта */
export function nextAircraftId(): string {
	const no = Math.max(0, ...fleet.map((a) => Number(a.id.split('-')[1]) || 0)) + 1;
	return uuid();
}

/** Записать борт: существующий заменяется, новый дописывается */
export function saveAircraft(aircraft: Aircraft): Aircraft {
	const i = fleet.findIndex((a) => a.id === aircraft.id);
	if (i >= 0) fleet[i] = aircraft;
	else fleet.push(aircraft);
	enqueue('борт', aircraft.id, aircraft);
	return fleet.find((a) => a.id === aircraft.id) as Aircraft;
}

export function removeAircraft(id: string) {
	const aircraft = aircraftById(id);
	const i = fleet.findIndex((a) => a.id === id);
	if (i >= 0) fleet.splice(i, 1);
	enqueue('борт', id, { id, revision: aircraft?.revision }, 'delete');
}

/**
 * Сколько часов наработки осталось до регламентного ТО.
 * Отрицательное значение — регламент просрочен, борт летает сверх ресурса.
 * Ноль циклом — регламент не задан, считать нечего.
 */
export function untilService(a: Aircraft): number | undefined {
	if (!a.service) return undefined;
	return +(a.serviced + a.service - a.hours).toFixed(2);
}

/** За сколько часов до ТО начинаем предупреждать */
export const SERVICE_WARNING = 10;

/** Состояние ресурса: запас, регламент близко, регламент просрочен */
export function serviceLevel(left: number | undefined): 'ok' | 'warn' | 'bad' | 'muted' {
	if (left === undefined) return 'muted';
	if (left <= 0) return 'bad';
	return left <= SERVICE_WARNING ? 'warn' : 'ok';
}

/** Борта по срочности ТО: сначала просроченные, потом ближайшие */
export function byService(): Aircraft[] {
	return fleet
		.filter((a) => a.service > 0 && a.status !== 'списан')
		.slice()
		.sort((a, b) => (untilService(a) ?? 0) - (untilService(b) ?? 0));
}
