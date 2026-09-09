import type { Column, Row } from '$lib/components/format';
import { ROLES } from '$lib/roles';
import { siteByName, siteNames } from '$lib/sites.svelte';

/**
 * Наборы столбцов. Данные лежат в mocs и не зависят от того, как их показывают:
 * один и тот же FLIGHT_ROWS выводится и коротким набором FLIGHT_COLUMNS,
 * и подробным JOURNAL_COLUMNS. Столбцы в наборе можно переставлять и убирать —
 * компонент рисует ровно то, что пришло пропсом.
 */

/** Статусы полёта (ФТ-5.7) → цвет плашки */
const FLIGHT_STATUS: Column['levels'] = {
	черновик: 'muted',
	запланирован: 'info',
	'подготовка пройдена': 'info',
	// борт в воздухе прямо сейчас: это не предупреждение, а состояние
	выполняется: 'live',
	завершён: 'ok',
	отменён: 'muted'
};

/**
 * Полёт с примечаниями пилота: плашка состояния красная, каким бы это
 * состояние ни было. Замечание — то, ради чего журнал и читают: «завершён»
 * зелёным рядом с записанной неисправностью говорит обратное тому, что было.
 */
const withNotes = (row: Row) => (row.notes?.length ? ('bad' as const) : undefined);

/** Годность борта (ФТ-3.3) → цвет плашки */
const FLEET_STATUS: Column['levels'] = {
	годен: 'ok',
	'в ремонте': 'bad',
	'на хранении': 'muted',
	списан: 'muted'
};

/** Учёт полётов: короткий набор для списка (ФТ-15.3) */
export const FLIGHT_COLUMNS: Column[] = [
	{ key: 'no', title: '№', num: true },
	{ key: 'date', title: 'Дата', format: 'date', filter: 'date' },
	{ key: 'aircraft', title: 'БВС' },
	{ key: 'pilot', title: 'Пилот' },
	{ key: 'task', title: 'Задача' },
	{ key: 'site', title: 'Локация' },
	{ key: 'takeoff', title: 'Начало', num: true, filter: 'time' },
	{ key: 'landing', title: 'Конец', num: true, filter: 'time' },
	{ key: 'duration', title: 'Дли-ть', num: true, format: 'duration', sum: true },
	{ key: 'status', title: 'Статус', format: 'status', levels: FLIGHT_STATUS, level: withNotes },
	{ key: 'checklist', title: 'Чеклист' },
	{ key: 'notes', title: 'Примечания', format: 'notes', num: true }
];

/**
 * Карточка полёта для Modal: все поля записи, включая те, которых нет в списке —
 * задачу, высоту, координаты площадки и ссылки на борт и пилота.
 */
export const FLIGHT_FIELDS: Column[] = [
	{ key: 'no', title: 'Номер записи', num: true },
	{
		key: 'status',
		title: 'Статус',
		format: 'status',
		levels: FLIGHT_STATUS,
		level: withNotes,
		edit: 'select'
	},
	{ key: 'date', title: 'Дата', format: 'date', edit: 'date' },
	{ key: 'aircraft', title: 'БВС' },
	{ key: 'aircraftId', title: 'Идентификатор борта' },
	{ key: 'pilot', title: 'Пилот' },
	// название чеклиста ведёт в протокол проверки, поэтому рисуется сниппетом
	{ key: 'checklist', title: 'Чеклист', format: 'custom' },
	{
		// площадка выбирается из справочника (ФТ-5.4): с одного места летают
		// годами, и свободный текст разошёлся бы в пять написаний одного поля
		key: 'site',
		title: 'Локация',
		edit: 'select',
		options: () => ['', ...siteNames()],
		sync: (row) => {
			const site = siteByName(row.site);
			if (!site) return;
			// координаты приходят вместе с названием: у площадки они и хранятся
			row.lat = site.lat;
			row.lon = site.lon;
		}
	},
	{ key: 'task', title: 'Задача', edit: 'text' },
	{ key: 'takeoff', title: 'Начало', num: true, edit: 'time' },
	{ key: 'landing', title: 'Конец', num: true, edit: 'time' },
	// продолжительность не правится руками: считается из времени взлёта и посадки (ФТ-10.3)
	{ key: 'duration', title: 'Продолжительность', format: 'duration', num: true },
	{
		key: 'alt',
		title: 'Максимальная высота',
		format: 'number',
		unit: 'м',
		num: true,
		edit: 'number'
	},
	{ key: 'notes', title: 'Примечания', format: 'notes' },
	// координаты последними: карта занимает высоту, и параметры полёта
	// должны читаться раньше неё, а не через неё
	{ key: 'coords', title: 'Координаты', format: 'custom' }
];

/** Журнал полётов: подробный набор по тем же данным (ФТ-10.1, ФТ-10.5–10.8) */
export const JOURNAL_COLUMNS: Column[] = [
	{ key: 'no', title: '№', num: true },
	{ key: 'date', title: 'Дата', format: 'date', filter: 'date' },
	{ key: 'aircraft', title: 'Борт' },
	{ key: 'pilot', title: 'Пилот' },
	{ key: 'site', title: 'Локация' },
	{ key: 'takeoff', title: 'Взлёт', num: true, filter: 'time' },
	{ key: 'landing', title: 'Посадка', num: true, filter: 'time' },
	{ key: 'duration', title: 'Налёт', num: true, format: 'duration', sum: true },
	{ key: 'alt', title: 'Высота', num: true, format: 'number', unit: 'м' },
	{ key: 'task', title: 'Задача' },
	{ key: 'status', title: 'Статус', format: 'status', levels: FLIGHT_STATUS, level: withNotes },
	{ key: 'notes', title: 'Примечания', format: 'notes', num: true }
];

/**
 * Парк БВС (ФТ-3.1–3.4, ФТ-14.1).
 */
export const FLEET_COLUMNS: Column[] = [
	{ key: 'no', title: '№', format: 'index', num: true },
	{ key: 'model', title: 'Модель' },
	{ key: 'reg', title: 'Учётный №' },
	{ key: 'status', title: 'Годность', format: 'status', levels: FLEET_STATUS },
	{ key: 'hours', title: 'Наработка', num: true, format: 'hours' },
	{ key: 'flights', title: 'Полётов', num: true, format: 'number' },
	// остаток ресурса считается из наработки и цикла ТО, поэтому рисуется
	// сниппетом: в данных борта такого поля нет. Ключ свой, не 'service':
	// цикл ТО и остаток до него — разные величины, и под одним именем
	// столбец таблицы и поле карточки называли бы разное одним словом
	{ key: 'resource', title: 'Ресурс', format: 'custom', sortable: false }
];

/**
 * Карточка борта для Modal (ФТ-3.1–3.3).
 * Наработка не правится: она считается из журнала (ФТ-3.4).
 */
export const FLEET_FIELDS: Column[] = [
	{ key: 'model', title: 'Модель', edit: 'text' },
	{ key: 'reg', title: 'Учётный №', edit: 'text' },
	{ key: 'status', title: 'Годность', format: 'status', levels: FLEET_STATUS, edit: 'select' },
	{ key: 'hours', title: 'Наработка', format: 'hours', num: true },
	{ key: 'flights', title: 'Полётов', format: 'number', num: true },
	// цикл ТО задаётся в часах наработки, отметка последнего ТО — в тех же
	// часах: по ним считается остаток ресурса до регламента (ФТ-3.10)
	// остаток до регламента — та же величина и то же название, что в столбце
	// таблицы: карточку открывают из строки и читают их подряд
	{ key: 'resource', title: 'Ресурс', format: 'custom' },
	{ key: 'service', title: 'Цикл ТО, часов', format: 'number', num: true, edit: 'number' },
	{ key: 'serviced', title: 'Наработка на момент ТО', format: 'hours', num: true, edit: 'number' }
];

/**
 * Ресурс до регламентного ТО на панели (ФТ-15.1а).
 * Остаток `left` считается из наработки и цикла и приходит в данных строки:
 * так по нему работает сортировка, а плашку состояния рисует сниппет.
 */
export const SERVICE_COLUMNS: Column[] = [
	{ key: 'model', title: 'Борт' },
	{ key: 'reg', title: 'Учётный №' },
	{ key: 'hours', title: 'Наработка', num: true, format: 'hours' },
	{ key: 'service', title: 'Цикл ТО', num: true, format: 'number', unit: 'ч' },
	{ key: 'left', title: 'До ТО', num: true, format: 'custom', sortable: true }
];

/**
 * Проблемные пункты чеклистов на панели (ФТ-15.10): где проверка регулярно
 * даёт отрицательный ответ или пункт остаётся пустым.
 */
export const TROUBLE_COLUMNS: Column[] = [
	{ key: 'title', title: 'Пункт' },
	{ key: 'checklist', title: 'Чеклист' },
	{ key: 'failed', title: 'Не соответствует', num: true, format: 'number' },
	{ key: 'skipped', title: 'Пропущено', num: true, format: 'number' },
	{ key: 'noted', title: 'С примечанием', num: true, format: 'number' }
];

/** Состояние аккумулятора (ФТ-11.4) → цвет плашки */
const BATTERY_STATUS: Column['levels'] = {
	'в строю': 'ok',
	'на хранении': 'muted',
	'на проверке': 'warn',
	выведен: 'bad'
};

/**
 * Учёт аккумуляторов (ФТ-11). Текущее и эталонное значение стоят отдельными
 * колонками: их сравнивают глазами, и слипшаяся пара «5310 из 5880» читается
 * хуже, чем два столбца, которые можно окинуть сверху вниз.
 *
 * Состояние стоит рядом с названием: «выведен» и «на проверке» меняют смысл
 * всех остальных цифр строки. Примечание живёт в карточке — в таблице оно
 * забирает ширину, а читают его, когда уже открыли запись.
 */
export const BATTERY_COLUMNS: Column[] = [
	{ key: 'no', title: 'Номер', format: 'index', num: true },
	{ key: 'serial', title: 'Название' },
	{ key: 'status', title: 'Состояние', format: 'status', levels: BATTERY_STATUS },
	{ key: 'started', title: 'Ввод в эксплуатацию', format: 'date', filter: 'date' },
	// дата и время проверки одной колонкой: это один момент, а не два параметра
	{ key: 'checked', title: 'Проверка', format: 'custom', filter: 'date', sortable: true },
	{ key: 'capacityNow', title: 'Текущая ёмкость', num: true, format: 'number', unit: 'мА·ч' },
	{ key: 'capacity', title: 'Эталонная ёмкость', num: true, format: 'number', unit: 'мА·ч' },
	{ key: 'outputNow', title: 'Текущая токоотдача', num: true, format: 'number', unit: 'А' },
	{ key: 'output', title: 'Эталонная токоотдача', num: true, format: 'number', unit: 'А' },
	{ key: 'wear', title: 'Процент износа', num: true, format: 'custom', sortable: true }
];

/**
 * Карточка аккумулятора (ФТ-11.1). Паспортные значения правятся отдельно
 * от измеренных: первые берутся из документов на батарею и не меняются,
 * вторые записывают после каждой проверки.
 */
export const BATTERY_FIELDS: Column[] = [
	{ key: 'serial', title: 'Серийный №', edit: 'text' },
	{ key: 'status', title: 'Состояние', format: 'status', levels: BATTERY_STATUS, edit: 'select' },
	{ key: 'started', title: 'В эксплуатации с', format: 'date', edit: 'date' },
	{ key: 'checked', title: 'Последняя проверка', format: 'date', edit: 'date' },
	{ key: 'checkedAt', title: 'Время проверки', num: true, edit: 'time' },
	{
		key: 'capacity',
		title: 'Ёмкость по паспорту',
		format: 'number',
		unit: 'мА·ч',
		num: true,
		edit: 'number'
	},
	{
		key: 'capacityNow',
		title: 'Ёмкость измеренная',
		format: 'number',
		unit: 'мА·ч',
		num: true,
		edit: 'number'
	},
	{
		key: 'output',
		title: 'Токоотдача по паспорту',
		format: 'number',
		unit: 'А',
		num: true,
		edit: 'number'
	},
	{
		key: 'outputNow',
		title: 'Токоотдача измеренная',
		format: 'number',
		unit: 'А',
		num: true,
		edit: 'number'
	},
	{ key: 'note', title: 'Примечание', edit: 'text' }
];

/** Состояние пользователя (ФТ-1.4) → цвет плашки */
const STAFF_STATUS: Column['levels'] = {
	активен: 'ok',
	приглашён: 'warn',
	деактивирован: 'muted'
};

/**
 * Штат (ФТ-2.1). Должности в списке нет: о человеке в системе говорит роль —
 * что ему можно, — а «Инженер по эксплуатации» ни на что не влияет. В карточке
 * поле осталось: карточка пользователя по ФТ-2.1 содержит должность.
 */
export const STAFF_COLUMNS: Column[] = [
	{ key: 'name', title: 'ФИО' },
	{ key: 'roles', title: 'Роли' },
	{ key: 'phone', title: 'Телефон', num: true },
	{ key: 'hours', title: 'Налёт', num: true, format: 'hours' },
	{ key: 'flights', title: 'Полётов', num: true, format: 'number' },
	{ key: 'status', title: 'Состояние', format: 'status', levels: STAFF_STATUS }
];

/**
 * Карточка пользователя для Modal (ФТ-2.1).
 * Должности здесь нет: в системе человека определяют роли — что ему можно, —
 * а «Инженер по эксплуатации» ни на что не влияет и ни во что не попадает.
 * Налёт и число полётов не правятся: считаются из журнала, как наработка борта.
 */
export const STAFF_FIELDS: Column[] = [
	{ key: 'name', title: 'ФИО', edit: 'text' },
	// роли выбираются из закрытого набора (раздел 2.1): из них считаются права,
	// и свободный текст здесь означал бы пользователя вообще без прав
	{ key: 'roles', title: 'Роли', format: 'tags', limit: ROLES.length, options: [...ROLES] },
	{ key: 'phone', title: 'Телефон', num: true, edit: 'text' },
	{ key: 'status', title: 'Состояние', format: 'status', levels: STAFF_STATUS, edit: 'select' },
	{ key: 'hours', title: 'Налёт', format: 'hours', num: true },
	{ key: 'flights', title: 'Полётов', format: 'number', num: true }
];

/**
 * Профиль текущего пользователя для Modal (ФТ-2.1).
 * Состояние и роли не правятся: их меняет администратор в штате (2.3) —
 * выдать себе роль из собственного профиля нельзя. Компании здесь нет:
 * она одна на установку и в карточке человека ничего не добавляет.
 */
export const PROFILE_FIELDS: Column[] = [
	{ key: 'name', title: 'ФИО', edit: 'text' },
	// роли показаны, но не правятся: назначает их администратор в штате (2.3),
	// и выдать роль себе из собственного профиля нельзя
	{ key: 'roles', title: 'Роли' },
	{ key: 'status', title: 'Состояние', format: 'status', levels: STAFF_STATUS },
	{ key: 'phone', title: 'Телефон', edit: 'text' },
	{ key: 'timezone', title: 'Часовой пояс', edit: 'text' }
];

/** Типы пунктов (ФТ-4.6) */
const KINDS: Column['map'] = {
	'да/нет': 'да/нет',
	число: 'число',
	выбор: 'выбор',
	текст: 'текст'
};

/**
 * Пункт чеклиста в карточке редактора (ФТ-4.4–4.9).
 * Поля диапазона, единицы и вариантов показываются только у тех типов
 * ответа, которым они нужны, — у нового пункта их нет.
 */
export const ITEM_FIELDS: Column[] = [
	{ key: 'title', title: 'Название', edit: 'text' },
	{ key: 'kind', title: 'Тип ответа', edit: 'select', map: KINDS },
	{ key: 'hint', title: 'Подсказка пилоту', edit: 'text' },
	// диапазон и единица нужны только числовому пункту, варианты — только выбору
	{ key: 'min', title: 'Минимум', num: true, edit: 'number', when: (r) => r.kind === 'число' },
	{ key: 'max', title: 'Максимум', num: true, edit: 'number', when: (r) => r.kind === 'число' },
	{ key: 'unit', title: 'Единица', edit: 'text', when: (r) => r.kind === 'число' },
	{
		key: 'options',
		title: 'Варианты ответа',
		format: 'tags',
		limit: 6,
		when: (r) => r.kind === 'выбор'
	},
	{ key: 'notes', title: 'Заготовки примечаний', format: 'tags', limit: 5 }
];

/**
 * Пункты чеклиста таблицей (ФТ-4.4). Порядок ручной: столбец «Порядок»
 * рисуется сниппетом cell — стрелками пункт двигают вверх и вниз.
 */
export const ITEM_COLUMNS: Column[] = [
	{ key: 'pos', title: '№', num: true },
	{ key: 'title', title: 'Пункт' },
	{ key: 'kind', title: 'Тип ответа' },
	{ key: 'order', title: 'Порядок', format: 'custom' }
];

/**
 * Ответы прохождения таблицей (ФТ-10.7). Только параметры чеклиста:
 * что проверяли, что ответил пилот и что приписал. Столбец ответа рисуется
 * сниппетом — цвет зависит от значения, а не от заголовка.
 */
export const RUN_COLUMNS: Column[] = [
	{ key: 'pos', title: '№', num: true, format: 'index' },
	{ key: 'title', title: 'Пункт' },
	{ key: 'kind', title: 'Тип ответа' },
	{ key: 'value', title: 'Ответ', format: 'custom' },
	{ key: 'note', title: 'Примечание' }
];
