import { persist } from '$lib/storage.svelte';
import { enqueue } from '$lib/sync.svelte';
import { uuid } from '$lib/api';
import type { Row } from '$lib/components/format';
import type { FlightRow } from '$lib/mocs/rows';
import { aircraftByModel, fleet } from '$lib/fleet.svelte';
import { listsFor } from '$lib/checklists.svelte';
import { isMe, me } from '$lib/session.svelte';
import { personById, staff } from '$lib/staff.svelte';
import { siteByName } from '$lib/sites.svelte';
import { hasPoint, lapse } from '$lib/components/format';

/**
 * Общий список полётов на время работы приложения.
 *
 * С телефона пилот планирует вылет, за компьютером администратор ведёт учёт —
 * данные должны быть одни и те же. Поэтому список живёт в модуле, а не в
 * состоянии страницы: иначе план, созданный на площадке, не появился бы
 * в журнале. Меняется по месту (push/splice), потому что экспортированную
 * переменную переприсвоить нельзя.
 */
export const flights = persist<FlightRow>('flights', []);

/** Статусы, в которых полёт ещё предстоит выполнить (ФТ-5.7) */
export const PLANNED = ['черновик', 'запланирован', 'подготовка пройдена'];

export function isPlanned(row: Row): boolean {
	return PLANNED.includes(row.status);
}

/**
 * Полёт состоялся: борт в воздухе или уже сел. План и черновик — намерение,
 * а не работа. Правило одно на всех, кто считает по журналу: календарь,
 * диаграммы и карта вылетов должны сходиться между собой, иначе в ячейке дня
 * единица, а на карте две точки.
 */
export function isFlown(row: Row): boolean {
	return row.status === 'выполняется' || row.status === 'завершён';
}

/** Полёт, который пилоту ещё предстоит завершить: план или уже идущий вылет */
export function isActive(row: Row): boolean {
	return isPlanned(row) || row.status === 'выполняется';
}

/**
 * Заготовка плана: номер продолжает журнал, дата — сегодняшняя (ФТ-5.1).
 * Пилотом подставляется тот, кто планирует, — он же и полетит; администратор
 * планирует за других, поэтому у него остаётся первый по справочнику.
 */
export function blankFlight(): FlightRow | undefined {
	const no = Math.max(0, ...flights.map((f) => f.no)) + 1;
	const self = isMe('пилот') ? personById(me.id) : undefined;
	const aircraft = fleet[0];
	const pilot = self ?? staff[0];
	// Пустая компания сначала заводит БВС и сотрудника. До этого создавать
	// некорректный план нельзя — и главное, кнопка не должна падать на `undefined`.
	if (!aircraft || !pilot) return undefined;
	return {
		id: uuid(),
		no,
		date: new Date().toISOString().slice(0, 10),
		status: 'запланирован',
		aircraftId: aircraft.id,
		aircraft: aircraft.model,
		pilotId: pilot.id,
		pilot: pilot.name,
		checklist: listsFor(aircraft.id)[0]?.title ?? '',
		checklistId: listsFor(aircraft.id)[0]?.id ?? '',
		runId: '',
		site: '',
		siteId: '',
		lat: 0,
		lon: 0,
		task: '',
		takeoff: '',
		landing: '',
		duration: 0,
		alt: 0,
		notes: []
	};
}

/** Записать полёт: существующий заменяется, новый дописывается. Возвращает id */
export function saveFlight(row: Row): string {
	// площадку выбрали, а координаты не подтянулись — берём их из справочника:
	// запись полёта без координат не годится ни плану, ни журналу (ФТ-10.1)
	const site = siteByName(row.site);
	const aircraft = aircraftByModel(row.aircraft);
	const checklist = listsFor(aircraft?.id ?? row.aircraftId).find(
		(list) => list.title === row.checklist
	);
	const updated = {
		...row,
		lat: hasPoint(row.lat, row.lon) ? row.lat : (site?.lat ?? row.lat),
		lon: hasPoint(row.lat, row.lon) ? row.lon : (site?.lon ?? row.lon),
		// налёт не вводится руками, а считается из времени взлёта и посадки (ФТ-10.3)
		duration: lapse(row.takeoff, row.landing),
		// имя выбрали в карточке — ссылку на справочник восстанавливаем по нему
		aircraftId: aircraft?.id ?? row.aircraftId,
		checklistId: checklist?.id ?? row.checklistId ?? '',
		pilotId: staff.find((p) => p.name === row.pilot)?.id ?? row.pilotId,
		siteId: site?.id ?? row.siteId ?? ''
	} as FlightRow;

	const i = flights.findIndex((f) => f.id === updated.id);
	if (i >= 0) flights[i] = updated;
	else flights.push(updated);
	enqueue('полёт', updated.id, updated);
	return updated.id;
}

/**
 * Чеклист переименовали — планы, которые на него ссылаются, догоняют имя.
 * Записи состоявшихся полётов не трогаем: в них хранится то название, по
 * которому проверяли, и переименование историю не переписывает (ФТ-4.10).
 */
export function retitleChecklist(aircraftId: string, from: string, to: string) {
	for (const f of flights) {
		if (f.aircraftId === aircraftId && f.checklist === from && isPlanned(f)) {
			f.checklist = to;
			enqueue('полёт', f.id, f);
		}
	}
}

export function removeFlight(id: string) {
	const flight = flightById(id);
	const i = flights.findIndex((f) => f.id === id);
	if (i >= 0) flights.splice(i, 1);
	enqueue('полёт', id, { id, revision: flight?.revision }, 'delete');
}

/** «Сейчас» в формате ЧЧ:ММ:СС — время фиксируется кнопкой в приложении (ФТ-10.2) */
function nowTime(): string {
	const d = new Date();
	return [d.getHours(), d.getMinutes(), d.getSeconds()]
		.map((v) => String(v).padStart(2, '0'))
		.join(':');
}

/** Подготовка пройдена: чеклист закрыт, борт ждёт вылета (ФТ-5.7) */
export function markPrepared(id: string) {
	const f = flights.find((x) => x.id === id);
	if (f && f.status !== 'выполняется' && f.status !== 'завершён') {
		f.status = 'подготовка пройдена';
		enqueue('полёт', f.id, f);
	}
}

/** Взлёт: фиксируем время и переводим полёт в «выполняется» (ФТ-10.2) */
export function startFlight(id: string) {
	const f = flights.find((x) => x.id === id);
	if (!f) return;
	f.takeoff = nowTime();
	f.landing = '';
	f.duration = 0;
	f.status = 'выполняется';
	enqueue('полёт', f.id, f);
}

/** Посадка: фиксируем время, налёт считается из взлёта и посадки (ФТ-10.3) */
export function finishFlight(id: string) {
	const f = flights.find((x) => x.id === id);
	if (!f) return;
	f.landing = nowTime();
	f.duration = lapse(f.takeoff, f.landing);
	f.status = 'завершён';
	enqueue('полёт', f.id, f);
}

/**
 * Момент старта для таймера. Считается из записи полёта, а не из отдельной
 * отметки в памяти: время взлёта хранится с секундами, и после перезагрузки
 * страницы таймер продолжает считать с той же точностью, а не с начала минуты.
 */
export function startedAt(id: string): number {
	const f = flights.find((x) => x.id === id);
	if (!f?.takeoff) return Date.now();
	const [h = 0, m = 0, s = 0] = f.takeoff.split(':').map(Number);
	const d = new Date();
	d.setHours(h, m, s, 0);
	return d.getTime();
}

/** Полёт по идентификатору — им связаны экран плана и чеклист */
export function flightById(id: string | null): FlightRow | undefined {
	return id ? flights.find((f) => f.id === id) : undefined;
}
