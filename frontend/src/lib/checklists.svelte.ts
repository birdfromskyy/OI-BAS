import { persist } from '$lib/storage.svelte';
import type { Row } from '$lib/components/format';
import type { Checklist, ChecklistItem } from '$lib/mocs/checklists';
import type { Aircraft } from '$lib/mocs/fleet';
import { me } from '$lib/session.svelte';
import { enqueue } from '$lib/sync.svelte';
import { uuid } from '$lib/api';

/**
 * Чеклисты на время работы приложения.
 *
 * Живут в модуле, а не в состоянии страницы: правят их в парке БВС,
 * а проходят с телефона, и обе стороны должны видеть одно и то же.
 * Копия моков — правка не должна менять исходные данные.
 */
export const checklists = persist<Checklist>('checklists', []);

/** Сколько чеклистов можно завести одному борту */
export const MAX_PER_AIRCRAFT = 3;

/**
 * Чеклисты борта. Их может быть несколько — например, короткий на перелёт
 * и полный на съёмочный день, — поэтому при планировании полёт указывает,
 * по какому из них пойдёт подготовка.
 */
export function listsFor(aircraftId: string): Checklist[] {
	return checklists.filter((c) => c.aircraftId === aircraftId);
}

/**
 * Чеклист, по которому идёт подготовка: названный в плане полёта, иначе
 * первый чеклист борта, иначе шаблон модели (ФТ-4.1, ФТ-4.2).
 */
export function checklistFor(aircraftId: string, model: string, title = ''): Checklist | undefined {
	const own = listsFor(aircraftId);
	return (
		own.find((c) => c.title === title) ??
		own[0] ??
		checklists.find((c) => c.aircraftId === '' && c.model === model)
	);
}

/** Шаблон модели, если он заведён (ФТ-4.2) */
export function templateFor(model: string): Checklist | undefined {
	return checklists.find((c) => c.aircraftId === '' && c.model === model);
}

/**
 * Любая правка создаёт новую версию (ФТ-4.10): прохождения ссылаются
 * на ту версию, по которой выполнялись, и историю это не трогает.
 */
function bump(list: Checklist) {
	list.version += 1;
	list.updated = new Date().toISOString().slice(0, 10);
	list.author = me.name;
}

/**
 * Создать чеклист борту. Из шаблона модели получается его копия —
 * дальше она правится независимо и на другие борта не влияет (ФТ-4.3).
 */
export function createFor(aircraft: Aircraft, fromTemplate: boolean): Checklist | undefined {
	const own = listsFor(aircraft.id);
	if (own.length >= MAX_PER_AIRCRAFT) return undefined;

	const template = fromTemplate ? templateFor(aircraft.model) : undefined;
	const no = Math.max(0, ...checklists.map((c) => Number(c.id.split('-')[1]) || 0)) + 1;

	const list: Checklist = {
		id: uuid(),
		aircraftId: aircraft.id,
		model: aircraft.model,
		title:
			// модель в названии не нужна: чеклист принадлежит конкретному борту,
			// а в списках рядом стоит колонка с бортом
			own.length === 0 ? 'Предполётная подготовка' : `Чеклист ${own.length + 1}`,
		version: 1,
		updated: new Date().toISOString().slice(0, 10),
		author: me.name,
		items: template ? structuredClone($state.snapshot(template.items)) : []
	};
	// возвращается именно хранимая запись, а не та, что была создана здесь:
	// список реактивный, и после push в нём лежит своя копия — правки в ней
	// до исходного объекта не доходят, и вызывающий работал бы с отражением
	checklists.push(list);
	enqueue('чеклист', list.id, list);
	return checklists[checklists.length - 1];
}

/**
 * Удаление логическое: сервер оставляет строку для истории и откажет, если
 * чеклист уже связан с полётом или прохождением. При таком отказе ближайший
 * bootstrap вернёт запись обратно в локальный список.
 */
export function removeChecklist(id: string) {
	const list = checklists.find((c) => c.id === id);
	const index = checklists.findIndex((c) => c.id === id);
	if (index >= 0) checklists.splice(index, 1);
	enqueue('чеклист', id, { id, revision: list?.revision }, 'delete');
}

/**
 * Переименование (ФТ-4.4). Название — то, чем чеклист выбирают в плане полёта,
 * поэтому оно должно отличать чеклисты одного борта друг от друга.
 * Возвращает пустую строку при успехе, иначе — причину отказа.
 */
export function renameChecklist(list: Checklist, title: string): string {
	const value = title.trim();
	if (!value) return 'Название не может быть пустым';
	if (value === list.title) return '';

	// в плане полёта чеклист выбирают по названию (ФТ-5.2), поэтому у одного
	// борта имена обязаны различаться — иначе выбор становится неоднозначным
	const taken = checklists.some(
		(c) => c.aircraftId === list.aircraftId && c.id !== list.id && c.title === value
	);
	if (taken) return 'У этого борта уже есть чеклист с таким названием';

	list.title = value;
	bump(list);
	enqueue('чеклист', list.id, list);
	return '';
}

/** Добавить или заменить пункт */
export function upsertItem(list: Checklist, row: Row) {
	const item = $state.snapshot(row) as ChecklistItem;
	const i = list.items.findIndex((x) => x.id === item.id);
	if (i >= 0) list.items[i] = item;
	else list.items.push(item);
	bump(list);
	enqueue('чеклист', list.id, list);
}

export function removeItem(list: Checklist, id: string) {
	const i = list.items.findIndex((x) => x.id === id);
	if (i < 0) return;
	list.items.splice(i, 1);
	bump(list);
	enqueue('чеклист', list.id, list);
}

/** Порядок пунктов задаётся вручную: пилот идёт по чеклисту сверху вниз (ФТ-4.4) */
export function moveItem(list: Checklist, id: string, step: -1 | 1) {
	const i = list.items.findIndex((x) => x.id === id);
	const j = i + step;
	if (i < 0 || j < 0 || j >= list.items.length) return;
	[list.items[i], list.items[j]] = [list.items[j], list.items[i]];
	bump(list);
	enqueue('чеклист', list.id, list);
}

/** Заготовка пункта: номер продолжает нумерацию внутри чеклиста */
export function blankItem(list: Checklist): ChecklistItem {
	const no = Math.max(0, ...list.items.map((x) => Number(x.id.split('-')[1]) || 0)) + 1;
	return {
		id: `i-${String(no).padStart(3, '0')}`,
		title: '',
		hint: '',
		kind: 'да/нет'
	};
}
