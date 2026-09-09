import { persist } from '$lib/storage.svelte';
import { uuid } from '$lib/api';
import { enqueue } from '$lib/sync.svelte';
import type { Battery } from '$lib/mocs/batteries';

/**
 * Аккумуляторы парка (ФТ-11).
 *
 * Живут на устройстве, как парк и штат: батареи заводит администратор,
 * а смотреть их состояние нужно и на площадке, где связи нет.
 */
// Батареи приходят из API при загрузке приложения. Не показываем локальные
// демоданные до ответа сервера: пустой список честнее чужих «заглушек».
export const batteries = persist<Battery>('batteries', []);

export function batteryById(id: string): Battery | undefined {
	return batteries.find((b) => b.id === id);
}

/** Идентификатор должен приниматься API и оставаться уникальным офлайн. */
export function nextBatteryId(): string {
	return uuid();
}

export function saveBattery(battery: Battery): Battery {
	// `row` из модального окна — реактивный proxy Svelte. В очередь кладём
	// обычную запись, чтобы она без ошибок сериализовалась и в localStorage,
	// и в JSON запроса.
	const record: Battery = { ...battery };
	const i = batteries.findIndex((b) => b.id === record.id);
	if (i >= 0) batteries[i] = record;
	else batteries.push(record);
	enqueue('аккумулятор', record.id, record);
	return batteries.find((b) => b.id === record.id) as Battery;
}

export function removeBattery(id: string) {
	const battery = batteryById(id);
	const i = batteries.findIndex((b) => b.id === id);
	if (i >= 0) batteries.splice(i, 1);
	enqueue('аккумулятор', id, { id, revision: battery?.revision }, 'delete');
}

/**
 * Износ: сколько процентов от паспортного значения батарея отдаёт сейчас.
 * Считается по худшему из двух — ёмкости и токоотдаче: батарея, держащая
 * ёмкость, но просевшая по току, в полёте подведёт так же.
 */
export function wear(b: Battery): number {
	const parts = [
		b.capacity > 0 ? b.capacityNow / b.capacity : 1,
		b.output > 0 ? b.outputNow / b.output : 1
	];
	return Math.round(Math.min(...parts) * 100);
}

/** За сколько процентов до паспорта батарея считается изношенной */
export const WEAR_WARNING = 90;
export const WEAR_CRITICAL = 80;

/** Состояние по износу: в норме, требует внимания, к полётам не годится */
export function wearLevel(percent: number): 'ok' | 'warn' | 'bad' {
	if (percent < WEAR_CRITICAL) return 'bad';
	return percent < WEAR_WARNING ? 'warn' : 'ok';
}
