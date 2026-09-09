/**
 * Общий словарь таблицы и карточки: как описывается поле и как значение
 * превращается в текст. Живёт отдельно от компонентов, потому что одну и ту же
 * запись показывают оба — дата, продолжительность и статус должны выглядеть
 * одинаково и в строке таблицы, и в модальном окне.
 */

/** Уровень для цветной плашки статуса */
export type StatusLevel = 'ok' | 'warn' | 'bad' | 'live' | 'info' | 'muted';

/** Строка данных: компоненты не знают её формы, читают значения по key */
export type Row = Record<string, any>;

/**
 * Действие над записью — кнопка в подвале карточки помимо правки и удаления:
 * «Чеклист», «Списать» и подобное. Набор у каждого экрана свой.
 */
export type RowAction = {
	key: string;
	/**
	 * Подпись кнопки. При заданном icon уходит в title и aria-label:
	 * кнопка остаётся понятной без зрения и при наведении.
	 */
	label: string;
	/**
	 * Иконка — разметка SVG строкой: `import trash from '$lib/assets/delite.svg?raw'`.
	 * Именно строкой, а не путём к файлу: у иконок stroke="currentColor",
	 * и через <img> они потеряли бы цвет кнопки.
	 */
	icon?: string;
	/** всплывающая подсказка, если подпись короткая */
	title?: string;
	/** оформление: обычное, акцентное, опасное (удаление, списание) */
	tone?: 'default' | 'accent' | 'danger';
	/** не показывать действие для этой строки (например, «Отменить» у завершённого) */
	hidden?: (row: Row) => boolean;
	/** показать, но заблокировать */
	disabled?: (row: Row) => boolean;
	onclick: (row: Row) => void;
};

/**
 * Кнопка над таблицей, справа от поиска: относится ко всей таблице,
 * а не к строке — «Запланировать полёт», «Добавить борт» и подобное.
 */
export type TableAction = {
	key: string;
	label: string;
	title?: string;
	/** Разметка SVG строкой, как у RowAction.icon */
	icon?: string;
	tone?: 'default' | 'accent' | 'danger';
	disabled?: boolean;
	onclick: () => void;
};

/**
 * Описание поля. В таблице это столбец, в карточке — строка списка,
 * поэтому один и тот же набор годится обоим.
 */
export type Column = {
	key: string;
	title: string;
	/** выравнивание вправо + табличные цифры */
	num?: boolean;
	/**
	 * как показывать значение:
	 * index — порядковый номер строки (значение из данных не берётся),
	 * hours — наработка в часах и минутах: 94:00, 07:30,
	 * tags — массив строк тегами: их добавляют и убирают поштучно,
	 * notes — массив строк: в таблице их количество, в карточке — списком,
	 * custom — отрисовка сниппетом: cell у таблицы, field у карточки
	 */
	format?:
		| 'text'
		| 'date'
		| 'duration'
		| 'hours'
		| 'number'
		| 'status'
		| 'notes'
		| 'tags'
		| 'index'
		| 'custom';
	/** для format: 'status' — соответствие значения уровню */
	levels?: Record<string, StatusLevel>;
	/**
	 * Уровень плашки по всей записи, а не по одному значению. Нужен там, где
	 * цвет статуса зависит от соседних полей: завершённый полёт с примечанием
	 * пилота закрыт, но «всё хорошо» о нём сказать нельзя. Вернул undefined —
	 * работает обычное соответствие из `levels`.
	 */
	level?: (row: Row) => StatusLevel | undefined;
	/** подмена машинного значения человекочитаемым: { vlos: 'визуальный' } */
	map?: Record<string, string>;
	/**
	 * Показывать поле только когда условие выполнено: диапазон нужен типу
	 * «число», варианты — типу «выбор». Проверяется по правящейся записи,
	 * поэтому поля появляются и исчезают прямо во время правки.
	 */
	when?: (row: Row) => boolean;
	/**
	 * Каким полем правится значение в карточке. Не задано — поле только для чтения:
	 * так закрыты идентификаторы и всё, что считается из других данных.
	 */
	edit?: 'text' | 'number' | 'date' | 'time' | 'select';
	/**
	 * Варианты для edit: 'select', когда они берутся из данных, а не из словаря:
	 * список бортов, список пилотов. Функцией — когда набор зависит от самой
	 * записи: чеклисты показываются те, что заведены выбранному борту.
	 * Без options варианты берутся из levels или map.
	 */
	options?: string[] | ((row: Row) => string[]);
	/**
	 * Что сделать с записью после выбора значения. Нужно там, где поля связаны:
	 * выбрали площадку — вместе с названием в запись приходят её координаты.
	 * Правит переданную копию, а не хранилище: карточка ещё не сохранена.
	 */
	sync?: (row: Row) => void;
	/**
	 * Отбор по столбцу прямо в шапке таблицы: 'date' — период дат,
	 * 'time' — промежуток времени суток. Сортировка отвечает на вопрос
	 * «в каком порядке», отбор — «что именно показывать», и одно другое
	 * не заменяет (ФТ-15.12).
	 */
	filter?: 'date' | 'time';
	/** суммировать столбец в подвале таблицы */
	sum?: boolean;
	/** участвует в поиске */
	search?: boolean;
	/** сортировка по столбцу; по умолчанию выключена у index/custom */
	sortable?: boolean;
	/** для format: 'tags' — сколько тегов можно добавить */
	limit?: number;
	/**
	 * для format: 'tags' — значения, которые нельзя ни добавить, ни убрать.
	 * Роль, которой правящий не распоряжается, показывается, но не снимается:
	 * администратор видит у пользователя роль владельца и не трогает её.
	 */
	locked?: string[];
	/** приписка после значения, например «м» или «ч» */
	unit?: string;
};

export const LEVEL_COLOR: Record<StatusLevel, string> = {
	ok: 'var(--color-heat-good)',
	warn: 'var(--color-heat-bad)',
	bad: 'var(--color-heat-critical, var(--color-heat-bad))',
	// происходящее сейчас: не оценка, а состояние, поэтому свой цвет
	live: 'var(--color-heat-live)',
	info: 'var(--color-accent)',
	muted: 'var(--color-text-muted)'
};

/**
 * Цвета плашки состояния инлайном, а не классами Tailwind: цвет один на все
 * три свойства и берётся из LEVEL_COLOR, поэтому новый уровень достаточно
 * добавить туда. Оформление плашки живёт в компоненте Tag, здесь только цвет —
 * им пользуются и другие элементы, которым плашка не нужна.
 */
export function tagStyle(level: StatusLevel): string {
	const c = LEVEL_COLOR[level];
	return `color: ${c}; border-color: ${c}; background: color-mix(in srgb, ${c} 15%, transparent)`;
}

/**
 * Оформление кнопки действия: рамка и текст своим цветом, фон им же в 15 %.
 * Строки записаны целиком — иначе Tailwind их не соберёт.
 * Отклик на наведение даёт класс click из layout.css, отдельных hover-правил нет.
 */
export const TONE: Record<string, string> = {
	default: 'click border-border text-text-muted',
	accent: 'click border-accent bg-accent/15 text-accent',
	danger: 'click border-heat-bad bg-heat-bad/15 text-heat-bad'
};

/**
 * 5045 → «1:24:05», 1080 → «0:18:00». Налёт хранится в секундах и показывается
 * как на часах, без подписей: рядом стоят столбцы взлёта и посадки в том же
 * виде, и глаз не спотыкается. Часы не дополняются нулём, чтобы налёт
 * не читался как время суток.
 */
export function duration(sec: number): string {
	const total = Math.max(0, Math.round(sec));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	return `${h}:${String(m).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 94 → «94:00», 7.5 → «07:30». Наработка копится часами, но показывается
 * как время: часы дополняются нулём до двух знаков, минуты — всегда.
 */
export function hours(v: number): string {
	let h = Math.floor(v);
	let m = Math.round((v - h) * 60);
	if (m === 60) {
		h += 1;
		m = 0;
	}
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** «13:20:05» → 48005: время суток в секундах от полуночи */
function clockSeconds(time: string): number {
	const [h = 0, m = 0, s = 0] = time.split(':').map(Number);
	return h * 3600 + m * 60 + s;
}

/**
 * «13:20:05» и «14:32:40» → 4355 секунд. Время считается в секундах: и полёты,
 * и предполётные проверки бывают короткими, и округление до минуты теряет
 * минуту на каждой записи (ФТ-10.3). Пустой конец — событие не закончено.
 */
export function lapse(from: string, till: string): number {
	if (!from || !till) return 0;
	const diff = clockSeconds(till) - clockSeconds(from);
	// событие перешло через полночь
	return diff < 0 ? diff + 24 * 3600 : diff;
}

const nf = new Intl.NumberFormat('ru-RU');
const fmtDate = new Intl.DateTimeFormat('ru-RU', {
	day: '2-digit',
	month: '2-digit',
	year: '2-digit'
});

export function showDate(iso: string): string {
	const [y, m, d] = String(iso).split('-').map(Number);
	return fmtDate.format(new Date(y, m - 1, d));
}

export function num(v: unknown): string {
	return nf.format(Number(v));
}

/** Значение поля текстом — общий вид для таблицы и карточки */
export function cellText(row: Row, c: Column): string {
	const raw = row[c.key];
	if (raw === undefined || raw === null || raw === '') return '—';
	// список значений — роли, теги: в строке таблицы они читаются перечислением
	if (Array.isArray(raw)) return raw.length > 0 ? raw.join(', ') : '—';
	// нулевая продолжительность бывает только у отменённого полёта — это не «0 мин»
	if (c.format === 'duration' && Number(raw) === 0) return '—';
	const v = c.map?.[String(raw)] ?? raw;
	const s =
		c.format === 'date'
			? showDate(v)
			: c.format === 'duration'
				? duration(Number(v))
				: c.format === 'hours'
					? hours(Number(v))
					: c.format === 'number'
						? num(v)
						: String(v);
	return c.unit ? `${s} ${c.unit}` : s;
}

/**
 * Координаты в формате СППИ: градусы, минуты и секунды без разделителей,
 * широта двумя градусными цифрами, долгота тремя, полушарие буквой —
 * 571237N0652859E. В этом виде точку принимает система представления
 * планов полётов, и переписывать её вручную не приходится (ФТ-14.4).
 */
function dms(value: number, digits: number, plus: string, minus: string): string {
	let rest = Math.round(Math.abs(value) * 3600);
	const d = Math.floor(rest / 3600);
	rest -= d * 3600;
	const m = Math.floor(rest / 60);
	const sec = rest - m * 60;
	const pad = (v: number, n = 2) => String(v).padStart(n, '0');
	return `${pad(d, digits)}${pad(m)}${pad(sec)}${value < 0 ? minus : plus}`;
}

export function sppi(lat: number, lon: number): string {
	return `${dms(lat, 2, 'N', 'S')}${dms(lon, 3, 'E', 'W')}`;
}

/** Точка на карте — тот же вид, что отдаёт устройство (см. $lib/meteo) */
export type Point = { lat: number; lon: number };

const SPPI = /^(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])$/i;
const DECIMAL = /^(-?\d{1,2}(?:[.,]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d+)?)$/;

/**
 * Разбор координат, введённых руками. Принимает две записи: СППИ
 * (571237N0652859E) — в ней координаты хранятся и подаются в систему
 * представления планов (ФТ-14.4), — и десятичные градусы через запятую,
 * потому что именно их отдают карты, навигаторы и заказчик в переписке.
 *
 * Возвращает undefined на всём, что не разобралось: пустое поле и опечатка
 * не должны молча превращаться в точку у берегов Африки.
 */
export function parsePoint(text: string): Point | undefined {
	const value = text.trim();

	const sppi = SPPI.exec(value.replace(/\s+/g, ''));
	if (sppi) {
		const [, d1, m1, s1, ns, d2, m2, s2, ew] = sppi;
		const lat = (+d1 + +m1 / 60 + +s1 / 3600) * (ns.toUpperCase() === 'S' ? -1 : 1);
		const lon = (+d2 + +m2 / 60 + +s2 / 3600) * (ew.toUpperCase() === 'W' ? -1 : 1);
		return within(lat, lon);
	}

	const decimal = DECIMAL.exec(value);
	if (decimal) {
		return within(Number(decimal[1].replace(',', '.')), Number(decimal[2].replace(',', '.')));
	}

	return undefined;
}

/** Координаты вне земных пределов — это опечатка, а не точка */
function within(lat: number, lon: number): Point | undefined {
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
	// округление до четырёх знаков: это около 10 м, точнее площадку не задают
	return { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
}

/** Задана ли точка. Нули — это не «нулевая широта», а «координат нет» */
export function hasPoint(lat: number, lon: number): boolean {
	return Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);
}

/**
 * Ссылка на точку для стороннего приложения карт. На телефоне её открывает
 * штатное приложение — у него свои офлайн-карты, и это единственный способ
 * увидеть местность, когда сети нет, а плитки не загружены.
 */
export function mapLink(lat: number, lon: number): string {
	return `geo:${lat},${lon}?q=${lat},${lon}`;
}

/** Значение строкой: массив примечаний склеивается, чтобы попасть в поиск */
export function plain(v: unknown): string {
	return Array.isArray(v) ? v.join(' ') : String(v ?? '');
}

/** Все поля записи как есть — запасной набор, когда описание полей не передано */
export function autoFields(row: Row): Column[] {
	return Object.keys(row).map((key) => ({
		key,
		title: key,
		num: typeof row[key] === 'number',
		format: Array.isArray(row[key]) ? ('notes' as const) : undefined
	}));
}
