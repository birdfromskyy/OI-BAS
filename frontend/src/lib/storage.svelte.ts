import { browser } from '$app/environment';

/**
 * Хранение состояния в localStorage.
 *
 * Пилот работает на площадке без связи: закрыл вкладку, разрядился телефон,
 * ушёл в другое приложение — данные должны остаться. Поэтому списки полётов,
 * чеклистов и прохождений живут не только в памяти, но и на устройстве.
 * Начальное состояние пустое: реальные записи приходят из API или из
 * офлайн-кэша того же сотрудника.
 */
// Kept separate from `ekipazh.access-token`: changing cached record formats
// must never silently log a person out of their permanent access link.
const PREFIX = 'ekipazh.data.';

/**
 * Версия формата локальных данных. При несовместимом изменении её поднимают,
 * чтобы устройство не пыталось прочитать старую структуру как новую.
 */
const SEED = 'backend-1';

if (browser) {
	try {
		if (localStorage.getItem(PREFIX + 'seed') !== SEED) {
			wipe();
			localStorage.setItem(PREFIX + 'seed', SEED);
		}
	} catch {
		// хранилище закрыто настройками браузера — работаем в памяти
	}
}

/** Стереть всё, что приложение сохранило на устройстве */
function wipe() {
	for (const key of Object.keys(localStorage)) {
		if (key.startsWith(PREFIX)) localStorage.removeItem(key);
	}
}

/**
 * Табличный офлайн-кэш изолирован по персональной ссылке. Это исключает
 * краткий показ данных предыдущего сотрудника, если на одном телефоне
 * открыли другую ссылку. Очередь — исключение: её записи дополнительно
 * маркированы actorId и должны пережить перевыпуск ссылки тому же человеку.
 */
function scope(): string {
	if (!browser) return 'server';
	const fromURL = new URL(location.href).searchParams.get('access');
	const value =
		fromURL ??
		sessionStorage.getItem('ekipazh.session-access-token') ??
		localStorage.getItem('ekipazh.access-token') ??
		'';
	// Токен уже является credential в localStorage; в имени ключа оставляем
	// только первые 128 бит, поэтому полный секрет не дублируется многократно.
	return value ? `user-${value.slice(0, 32)}` : 'anonymous';
}

function storageKey(key: string, shared: boolean) {
	return PREFIX + (shared ? `shared.${key}` : `${scope()}.${key}`);
}

function load<T>(key: string, shared = false): T | undefined {
	if (!browser) return undefined;
	try {
		const raw = localStorage.getItem(storageKey(key, shared));
		return raw ? (JSON.parse(raw) as T) : undefined;
	} catch {
		// повреждённая или чужая запись не должна мешать запуску
		return undefined;
	}
}

function save(key: string, text: string, shared = false) {
	try {
		localStorage.setItem(storageKey(key, shared), text);
	} catch {
		// место кончилось или запись запрещена: работаем дальше в памяти
	}
}

/**
 * Persist a critical change synchronously. Reactive effects are excellent for
 * ordinary cache updates, but an offline outbox must be on disk before the UI
 * closes its editor or starts an HTTP request.
 */
export function persistNow<T>(key: string, value: T, shared = false) {
	if (!browser) return;
	try {
		save(key, JSON.stringify(value), shared);
	} catch {
		// An unavailable localStorage must not turn a completed form into an
		// exception. The in-memory queue still remains usable for this session.
	}
}

/**
 * Список, переживающий перезагрузку. Возвращает обычный реактивный массив:
 * меняется по месту (push, splice, присваивание элемента), а запись на диск
 * идёт сама при любом изменении.
 */
export function persist<T>(key: string, initial: T[], shared = false): T[] {
	// разметку собирает устройство (ssr выключен), поэтому сохранённое
	// подставляется сразу: расходиться с серверным рендером уже не с чем
	const state = $state<T[]>(load<T[]>(key, shared) ?? initial);

	if (browser) {
		$effect.root(() => {
			$effect(() => {
				// stringify читает весь массив, поэтому эффект видит любое изменение внутри
				save(key, JSON.stringify(state), shared);
			});
		});
	}

	return state;
}

/**
 * Одна запись, переживающая перезагрузку: профиль текущего пользователя,
 * настройки. Правится по месту (`me.name = …`), сохраняется сама.
 *
 * Сохранённое накладывается на начальное, а не заменяет его: когда в записи
 * появляется новое поле, у тех, кто пользовался прошлой версией, оно берётся
 * из начального значения, а не оказывается пустым.
 */
export function persistOne<T extends object>(key: string, initial: T): T {
	const state = $state<T>({ ...initial, ...(load<T>(key) ?? {}) });

	if (browser) {
		$effect.root(() => {
			$effect(() => {
				save(key, JSON.stringify(state));
			});
		});
	}

	return state;
}

/** Сбросить сохранённое и вернуться к мокам — нужно при отладке */
export function forget(key: string) {
	if (browser) localStorage.removeItem(storageKey(key, false));
}

/**
 * Начать с чистого устройства: стереть всё сохранённое и перезагрузить.
 * Нужно и при отладке, и в демонстрации — например, когда учётная запись
 * на этом устройстве деактивирована и войти больше нечем.
 */
export function forgetAll() {
	if (!browser) return;
	try {
		wipe();
	} catch {
		// нечего стирать
	}
	location.reload();
}
