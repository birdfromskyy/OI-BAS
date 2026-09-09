import { persist } from '$lib/storage.svelte';

/**
 * Приглашения по ссылке (ФТ-1.2, ФТ-1.3, ФТ-1.5).
 *
 * Ссылка — это ключ от учётной записи: пароля дальше не спросят, кто открыл,
 * тот и вошёл. Поэтому приглашение всегда персональное и одноразовое: оно
 * создаётся вместе с карточкой сотрудника, ведёт именно в неё и гаснет после
 * первого входа. Общей ссылки «для всех желающих» в системе нет — при входе
 * без пароля она означала бы, что доступ получает любой, кому её переслали.
 *
 * Остальное здесь про то же: срок действия, отзыв в любой момент и отметка
 * о переходе, чтобы было видно, что ссылкой уже воспользовались.
 */
export type Invite = {
	/** Он же токен в ссылке: /join?invite=<id> */
	id: string;
	/** Кому выдано. Роли пришедший получит из своей карточки в штате */
	personId: string;
	created: string;
	expires: string;
	/** Сколько раз ссылкой воспользовались; больше нуля — она уже сработала */
	used: number;
	/** Дата отзыва, ISO. Пустая — приглашение живо (ФТ-1.5) */
	revoked: string;
	author: string;
};

export const invites = persist<Invite>('invites', []);

/** Срок действия ссылки по умолчанию, дней (ФТ-1.3) */
export const DEFAULT_DAYS = 7;

export type InviteState = 'действует' | 'истекло' | 'отозвано' | 'использовано';

export function stateOf(invite: Invite): InviteState {
	if (invite.revoked) return 'отозвано';
	if (invite.used > 0) return 'использовано';
	if (Date.parse(invite.expires) < Date.now()) return 'истекло';
	return 'действует';
}

export function inviteById(id: string | null): Invite | undefined {
	return id ? invites.find((i) => i.id === id) : undefined;
}

/**
 * Действующее приглашение сотрудника. Пока он не вошёл, ссылку можно скопировать
 * ещё раз — потерять её проще простого, а восстановить пароль здесь нечем.
 */
export function inviteFor(personId: string): Invite | undefined {
	return invites.find((i) => i.personId === personId && stateOf(i) === 'действует');
}

function fresh(): string {
	return typeof crypto !== 'undefined' && crypto.randomUUID
		? crypto.randomUUID()
		: `i-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Выдать сотруднику ссылку. Прежняя отзывается: действующая должна быть одна,
 * иначе отозвать её невозможно — где-то останется живая копия.
 */
export function inviteToPerson(personId: string, days: number, author: string): Invite {
	for (const i of invites) {
		if (i.personId === personId && stateOf(i) === 'действует') revokeInvite(i);
	}

	const now = new Date();
	const invite: Invite = {
		id: fresh(),
		personId,
		created: now.toISOString(),
		expires: new Date(now.getTime() + Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString(),
		used: 0,
		revoked: '',
		author
	};

	// возвращается именно хранимая запись, а не та, что создана здесь: список
	// реактивный, и после push в нём лежит своя копия — правки в ней до
	// исходного объекта не доходят, и вызывающий работал бы с отражением
	invites.push(invite);
	return invites[invites.length - 1];
}

/** Отозвать ссылку: тот, кто уже вошёл по ней, доступ сохраняет (ФТ-1.5) */
export function revokeInvite(invite: Invite) {
	invite.revoked = new Date().toISOString();
}

/** Отметить переход по ссылке — одноразовая этим и гасится */
export function useInvite(invite: Invite) {
	invite.used += 1;
}

/** Ссылка целиком — её передают любым удобным способом (ФТ-1.2) */
export function linkFor(invite: Invite): string {
	const origin = typeof location === 'undefined' ? '' : location.origin;
	return `${origin}/join?invite=${invite.id}`;
}
