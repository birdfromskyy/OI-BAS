import { FLIGHTS_MOCK, type FlightRecord } from '$lib/mocs/flights';
import { FLEET_MOCK } from '$lib/mocs/fleet';
import { STAFF_MOCK } from '$lib/mocs/staff';

/**
 * Сборка строк для таблиц.
 *
 * В моках лежат только ссылки (aircraftId, pilotId) — название борта и ФИО
 * пилота хранятся ровно в одном месте, в своих справочниках. Таблица же читает
 * значения плоско, по ключу столбца, поэтому ссылки нужно развернуть заранее.
 * Это тот же JOIN, который потом сделает сервер: когда появится API, файл
 * заменяется запросом, а компонент и наборы столбцов не меняются.
 */
const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((x) => [x.id, x]));

const fleet = byId(FLEET_MOCK);
const staff = byId(STAFF_MOCK);

/** Строка учёта полётов: запись плюс развёрнутые названия */
export type FlightRow = FlightRecord & { aircraft: string; pilot: string };

export const FLIGHT_ROWS: FlightRow[] = FLIGHTS_MOCK.map((f) => ({
	...f,
	// борт мог быть списан и убран из парка — строку журнала это ломать не должно
	aircraft: fleet.get(f.aircraftId)?.model ?? '—',
	pilot: staff.get(f.pilotId)?.name ?? '—'
}));
