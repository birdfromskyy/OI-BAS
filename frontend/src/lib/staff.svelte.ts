import { persist } from '$lib/storage.svelte';
import type { Person } from '$lib/mocs/staff';
import { OWNER, type Role } from '$lib/roles';

/**
 * Штат компании на время работы приложения.
 *
 * Живёт в модуле и на устройстве, а не в состоянии страницы: роли назначают
 * в штате, а спрашивают их все экраны, и назначение, не пережившее
 * перезагрузку, — это не назначение (ФТ-1.2, ФТ-2.1).
 */
export const staff = persist<Person>('staff', []);

/** Пользователь по идентификатору — им связаны полёты, планы и профиль */
export function personById(id: string): Person | undefined {
	return staff.find((p) => p.id === id);
}

/** Кого можно поставить пилотом полёта: те, у кого есть роль пилота */
export function pilotNames(): string[] {
	return staff.filter((p) => p.roles.includes('пилот')).map((p) => p.name);
}

/** Действующий владелец компании; их всегда не больше одного */
export function ownerOf(): Person | undefined {
	return staff.find((p) => p.roles.includes(OWNER));
}

/**
 * Следующий свободный номер: на единицу больше самого большого занятого.
 * От длины списка нельзя — после удаления из середины номер повторится,
 * а одинаковый id ломает и ключи строк таблицы, и ссылки на пилота.
 */
export function nextPersonId(): string {
	const no = Math.max(0, ...staff.map((p) => Number(p.id.split('-')[1]) || 0)) + 1;
	return `u-${String(no).padStart(3, '0')}`;
}

/**
 * Записать пользователя: существующий заменяется, новый дописывается.
 * Возвращает хранимую запись — правки в ней видит всё приложение, а копия,
 * из которой её собрали, живёт своей жизнью и никого не оповещает.
 */
export function savePerson(person: Person): Person {
	const i = staff.findIndex((p) => p.id === person.id);
	if (i >= 0) staff[i] = person;
	else staff.push(person);
	return staff.find((p) => p.id === person.id) as Person;
}

export function removePerson(id: string) {
	const i = staff.findIndex((p) => p.id === id);
	if (i >= 0) staff.splice(i, 1);
}

/**
 * Передать владение компанией. Роль владельца не выдаётся второму человеку,
 * а переходит: у прежнего она снимается тем же действием — иначе владельцев
 * становится двое, и «назначить администратора» перестаёт быть исключительным
 * правом (2.1). Возвращает роли, оставшиеся у прежнего владельца.
 */
export function transferOwnership(toId: string): Role[] {
	const heir = personById(toId);
	if (!heir || heir.roles.includes(OWNER)) return [];

	let left: Role[] = [];
	for (const p of staff) {
		if (p.roles.includes(OWNER)) {
			p.roles = p.roles.filter((r) => r !== OWNER);
			left = [...p.roles];
		}
	}
	heir.roles = [OWNER, ...heir.roles];
	return left;
}
