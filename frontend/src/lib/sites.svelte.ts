import { persist } from '$lib/storage.svelte';
import type { Site } from '$lib/mocs/sites';
import { enqueue } from '$lib/sync.svelte';
import { uuid } from '$lib/api';

/**
 * Справочник площадок (ФТ-5.4).
 *
 * Живёт на устройстве вместе с остальными данными: площадку выбирают
 * при планировании, а планируют в том числе на выезде, где сети нет.
 */
export const sites = persist<Site>('sites', []);

/** Названия для выбора в карточке полёта */
export function siteNames(): string[] {
	return sites.map((s) => s.name);
}

export function siteByName(name: string): Site | undefined {
	return sites.find((s) => s.name === name);
}

/**
 * Ближайшая известная площадка к точке (ФТ-7.3). Расстояние считается
 * по плоскости с поправкой на широту: на десятках километров ошибка
 * такого счёта меньше метра, а тригонометрии на порядок меньше.
 */
export function nearestSite(lat: number, lon: number, within = 1): Site | undefined {
	let best: Site | undefined;
	let min = Infinity;
	for (const s of sites) {
		const dy = s.lat - lat;
		const dx = (s.lon - lon) * Math.cos((lat * Math.PI) / 180);
		const km = Math.hypot(dy, dx) * 111.32;
		if (km < min) {
			min = km;
			best = s;
		}
	}
	return min <= within ? best : undefined;
}

/** Следующий свободный номер площадки */
export function nextSiteId(): string {
	return uuid();
}

/**
 * Записать площадку. Возвращается хранимая запись: список реактивный,
 * и после push в нём лежит своя копия.
 */
export function saveSite(site: Site): Site {
	const record: Site = { ...site };
	const i = sites.findIndex((s) => s.id === record.id);
	if (i >= 0) sites[i] = record;
	else sites.push(record);
	enqueue('площадка', record.id, record);
	return sites.find((s) => s.id === record.id) as Site;
}

/** Завести площадку по точке на карте: имя даёт пилот, координаты — карта */
export function addSite(name: string, lat: number, lon: number, note = ''): Site {
	return saveSite({ id: nextSiteId(), name: name.trim(), lat, lon, note });
}
