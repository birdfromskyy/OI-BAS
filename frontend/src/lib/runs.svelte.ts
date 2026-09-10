import { persist } from '$lib/storage.svelte';
import { enqueue } from '$lib/sync.svelte';
import type { Answer, Run } from '$lib/mocs/runs';
import type { Checklist } from '$lib/mocs/checklists';
import type { FlightRow } from '$lib/mocs/rows';
import type { Spot } from '$lib/meteo';
import { lapse } from '$lib/components/format';
import { uuid } from '$lib/api';
import { me } from '$lib/session.svelte';

/**
 * Прохождения чеклистов на время работы приложения.
 *
 * Живут отдельно от полётов и от чеклистов: полёт ссылается на прохождение,
 * прохождение — на версию чеклиста, и ни одна правка чеклиста не меняет
 * того, что уже проверено (ФТ-4.10, ФТ-6.9, ФТ-10.7).
 */
export const runs = persist<Run>('runs', []);

/** «Сейчас» в формате ЧЧ:ММ:СС: проверка занимает минуты, и секунды в ней видны */
function clock(): string {
	const d = new Date();
	return [d.getHours(), d.getMinutes(), d.getSeconds()]
		.map((v) => String(v).padStart(2, '0'))
		.join(':');
}

/** Прохождения полёта, новые сверху; аннулированные тоже возвращаются */
export function runsFor(flightId: string): Run[] {
	return runs.filter((r) => r.flightId === flightId).reverse();
}

/** Действующее прохождение полёта: последнее неаннулированное */
export function runFor(flightId: string): Run | undefined {
	return runsFor(flightId).find((r) => !r.voided);
}

/** Начатое, но не подписанное прохождение — к нему можно вернуться (ФТ-6.7) */
export function openRunFor(flightId: string): Run | undefined {
	const run = runFor(flightId);
	return run && !run.signature ? run : undefined;
}

/**
 * Начать прохождение. Обязательные параметры фиксируются сразу: дата, время
 * начала и пилот — из плана и часов, координаты — с устройства, погода —
 * по этим координатам от метеослужбы, с возможностью поправить руками.
 */
export function startRun(
	flight: FlightRow,
	list: Checklist,
	weather: string,
	spot?: Spot | null
): Run {
	const no = Math.max(0, ...runs.map((r) => Number(r.id.split('-')[1]) || 0)) + 1;
	const run: Run = {
		id: uuid(),
		flightId: flight.id,
		// Проверку может провести любой пилот команды; ответственным за взлёт
		// остаётся пилот, указанный в самом полёте.
		pilotId: me.id,
		checklistId: list.id,
		checklist: list.title,
		version: list.version,
		date: flight.date,
		startedAt: clock(),
		finishedAt: '',
		site: flight.site,
		// координаты с устройства, если разрешили; иначе плановые из полёта
		lat: spot?.lat ?? flight.lat,
		lon: spot?.lon ?? flight.lon,
		weather,
		pilot: me.name,
		answers: list.items.map((i) => ({ itemId: i.id, title: i.title, value: null, note: '' })),
		description: '',
		signature: '',
		voided: ''
	};
	// возвращается именно хранимая запись, а не та, что была создана здесь:
	// список реактивный, и после push в нём лежит своя копия — правки в ней
	// до исходного объекта не доходят, и вызывающий работал бы с отражением
	runs.push(run);
	const stored = runs[runs.length - 1];
	// Первое же действие в чеклисте должно пережить закрытие PWA и bootstrap.
	// Не ждём подписи: незавершённая подготовка тоже является рабочими данными.
	enqueue('прохождение', stored.id, stored);
	flight.runId = stored.id;
	enqueue('полёт', flight.id, flight);
	return stored;
}

/** Записать ответ по пункту. Пишется сразу, чтобы прогресс не терялся (ФТ-6.7) */
export function answerItem(run: Run, itemId: string, value: Answer['value'], note: string) {
	const a = run.answers.find((x) => x.itemId === itemId);
	if (!a) return;
	a.value = value;
	a.note = note;
	enqueue('прохождение', run.id, run);
}

/** Подпись закрывает прохождение: дальше оно неизменяемо (ФТ-6.9) */
export function signRun(run: Run, signature: string, description: string) {
	run.finishedAt = clock();
	run.signature = signature;
	run.description = description;
	// подписанное прохождение неизменяемо, значит его можно отправлять
	enqueue('прохождение', run.id, run);
}

/** Переделка проверки: прежнее прохождение сохраняется с причиной (ФТ-6.9) */
export function voidRun(run: Run, reason: string) {
	run.voided = reason;
	enqueue('прохождение', run.id, run);
}

/** Сводка по прохождению: заполнено, пропущено, отрицательных, примечаний */
export function summaryOf(run: Run | undefined) {
	const answers = run?.answers ?? [];
	return {
		total: answers.length,
		filled: answers.filter((a) => a.value !== null).length,
		skipped: answers.filter((a) => a.value === null).length,
		failed: answers.filter((a) => a.value === false).length,
		notes: answers.filter((a) => a.note !== '').length
	};
}

/* ── Качество подготовки (ФТ-15.10) ────────────────────────────────────────
 *
 * Считается по подписанным и не аннулированным прохождениям: незакрытая
 * проверка ещё идёт, а аннулированная заменена другой, и обе исказили бы
 * картину. Средних и долей здесь нет намеренно: доля ни к чему не обязывает,
 * а вот конкретная проверка, пройденная за десять секунд на пункт, и пункт,
 * отказывающий не в первый раз, — обязывают. Из них собирается «Требует
 * внимания» ($lib/attention).
 */

/** Прохождения, по которым судят о качестве: закрытые и действующие */
export function doneRuns(): Run[] {
	return runs.filter((r) => r.signature !== '' && r.voided === '');
}

/**
 * Порог «подозрительно быстро», секунд на пункт. Десять секунд — это открыть
 * пункт, прочитать название и нажать кнопку; осмотреть при этом нечего.
 */
export const FAST_SECONDS = 10;

/** Сколько секунд заняла проверка. Незакрытая — ноль */
export function runSeconds(run: Run): number {
	return lapse(run.startedAt, run.finishedAt);
}

/** Секунд на пункт: длительность, приведённая к длине чеклиста */
export function secondsPerItem(run: Run): number {
	const items = run.answers.length;
	return items > 0 ? runSeconds(run) / items : 0;
}

/** Пункт, который чаще прочих даёт отрицательный ответ или остаётся пустым */
export type Trouble = {
	id: string;
	title: string;
	checklist: string;
	failed: number;
	skipped: number;
	noted: number;
};

/**
 * Проблемные пункты: по ним видно, где техника подводит регулярно, а где
 * пункт написан так, что его пропускают. И то и другое — повод править
 * чеклист или чинить борт, а не пилота.
 */
export function troubleItems(list: Run[] = doneRuns()): Trouble[] {
	const found = new Map<string, Trouble>();
	for (const run of list) {
		for (const a of run.answers) {
			const key = `${run.checklistId}/${a.itemId}`;
			const item = found.get(key) ?? {
				id: key,
				title: a.title,
				checklist: run.checklist,
				failed: 0,
				skipped: 0,
				noted: 0
			};
			if (a.value === false) item.failed += 1;
			if (a.value === null) item.skipped += 1;
			if (a.note !== '') item.noted += 1;
			found.set(key, item);
		}
	}
	return [...found.values()]
		.filter((i) => i.failed > 0 || i.skipped > 0)
		.sort((a, b) => b.failed - a.failed || b.skipped - a.skipped);
}
