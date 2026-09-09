/**
 * Профиль текущего пользователя (ФТ-2.1, ФТ-1.8).
 *
 * Отдельный тип, а не расширение Person: в профиле оставлено только то,
 * что показывается владельцу учётной записи, плюс часовой пояс из настроек
 * компании — налёт, должность и прочее хозяйство штата ему не нужны.
 */
import type { Role } from '$lib/roles';
import { COMPANY } from '$lib/mocs/company';
import { STAFF_MOCK } from '$lib/mocs/staff';

export type Profile = {
	id: string;
	name: string;
	/** Роли списком: у пользователя их может быть несколько (ФТ-1.2) */
	roles: Role[];
	phone: string;
	/** активен / приглашён / деактивирован (ФТ-1.4) */
	status: string;
	/** Часовой пояс из настроек компании (ФТ-1.8) */
	timezone: string;
};

/**
 * Профиль, с которого начинается работа на новом устройстве: первый в штате,
 * то есть владелец, зарегистрировавший компанию (ФТ-1.1).
 *
 * Собирается из карточки штата, а не переписывается рядом с ней: это один
 * и тот же человек, и две копии его ФИО и ролей неминуемо разъезжаются —
 * правка мока штата переставала быть видна в профиле.
 */
const first = STAFF_MOCK[0];

export const PROFILE_MOCK: Profile = {
	id: first.id,
	name: first.name,
	roles: [...first.roles],
	phone: first.phone,
	status: first.status,
	timezone: COMPANY.timezone
};
