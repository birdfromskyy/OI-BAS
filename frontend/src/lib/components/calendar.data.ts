import type { DayStat, WarningLevel } from '$lib/components/Calendar.svelte';
import type { Row } from '$lib/components/format';
import { isFlown } from '$lib/flights.svelte';

/**
 * Сбор данных календаря из журнала полётов (ФТ-15.2).
 *
 * Календарь показывает не сами полёты, а их количество по дням, поэтому
 * записи группируются по дате. Дни без полётов в набор не попадают —
 * компонент рисует их пустыми сам.
 */

/**
 * Оттенок дня. Раньше он брался от предупреждений проверок; их в структуре
 * больше нет, и роль тревожного признака перешла к примечаниям и отменам:
 * отменённый полёт красит день красным, примечание пилота — янтарным.
 */
function levelOf(rows: Row[]): WarningLevel {
	if (rows.some((r) => r.status === 'отменён')) return 'critical';
	if (rows.some((r) => (r.notes?.length ?? 0) > 0)) return 'significant';
	return 'none';
}

export function calendarDays(flights: Row[]): DayStat[] {
	const byDate = new Map<string, Row[]>();
	for (const f of flights) {
		if (!f.date) continue;
		byDate.set(f.date, [...(byDate.get(f.date) ?? []), f]);
	}

	return (
		[...byDate.entries()]
			.map(([date, rows]) => ({
				date,
				flights: rows.filter(isFlown).length,
				level: levelOf(rows)
			}))
			// день, где все полёты отменены, всё равно нужен: он красит ячейку
			.filter((d) => d.flights > 0 || d.level !== 'none')
			.sort((a, b) => a.date.localeCompare(b.date))
	);
}
