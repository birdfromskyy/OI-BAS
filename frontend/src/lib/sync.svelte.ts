import { browser } from '$app/environment';
import { persist, persistNow } from '$lib/storage.svelte';
import { APIError, api, uuid } from '$lib/api';

/**
 * Очередь отправки на сервер.
 *
 * Всё, что пилот делает на площадке, сначала ложится на устройство и в эту
 * очередь, а уходит наружу при первой возможности. Так предполётная проверка
 * и полёт выполняются без связи, а записи не теряются: отправка — отдельный
 * шаг, а не условие работы.
 */

/** Что отправляем: запись полёта или прохождение чеклиста */
export type Parcel = {
	id: string;
	kind: 'борт' | 'чеклист' | 'полёт' | 'прохождение' | 'площадка' | 'аккумулятор';
	/** Идентификатор записи: повторная правка заменяет прежнюю посылку */
	ref: string;
	payload: unknown;
	action: 'upsert' | 'delete';
	/** Очередь принадлежит конкретному пользователю, а не браузеру целиком. */
	actorId: string;
	/** Конфликт или отозванный доступ не повторяем автоматически и не теряем. */
	blocked: string;
	/** Когда положили в очередь и когда отправили, ISO */
	queued: string;
	sent: string;
};

// Очередь общая для ссылок одного браузера: каждая посылка всё равно связана
// с actorId и не отправится до подтверждения именно этого пользователя.
export const outbox = persist<Parcel>('outbox', [], true);

function persistOutbox() {
	persistNow('outbox', outbox, true);
}

/**
 * Svelte collections are reactive proxies. They are valid for rendering and
 * JSON, but not necessarily for the structured clone algorithm. Sync payloads
 * are JSON documents by contract, so a JSON round trip is the correct stable
 * boundary before storage, HTTP and CustomEvent dispatch.
 */
function jsonCopy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

const ENTITY: Record<Parcel['kind'], string> = {
	борт: 'aircraft',
	чеклист: 'checklist',
	полёт: 'flight',
	прохождение: 'run',
	площадка: 'site',
	аккумулятор: 'battery'
};

/** Состояние сети. Отдельный объект, потому что реактивной должна быть величина, а не модуль */
export const net = $state({
	online: browser ? navigator.onLine : true,
	sending: false,
	error: '',
	blocked: 0
});

const ACTOR_KEY = 'ekipazh.sync-actor';
let actorId = browser ? (sessionStorage.getItem(ACTOR_KEY) ?? '') : '';
// Значение из sessionStorage само по себе не доверенно: вход по другой ссылке
// может оставить там ID прошлого пользователя. Синхронизацию включает только
// профиль из кэша той же ссылки или свежий ответ bootstrap.
let syncAuthorized = false;

/** Вызывается после подтверждённого bootstrap и не даёт разным людям смешать очереди на одном устройстве. */
export function setSyncActor(id: string) {
	actorId = id;
	syncAuthorized = id !== '';
	if (browser) {
		if (id) sessionStorage.setItem(ACTOR_KEY, id);
		else sessionStorage.removeItem(ACTOR_KEY);
	}
	net.blocked = outbox.filter((p) => p.actorId === actorId && p.blocked !== '').length;
	if (browser && id && net.online) void flush();
}

/** Сколько записей ждёт отправки */
export function pending(): Parcel[] {
	return outbox.filter((p) => !p.sent && !p.blocked && p.actorId === actorId);
}

export function blocked(): Parcel[] {
	return outbox.filter((p) => !p.sent && p.blocked !== '' && p.actorId === actorId);
}

/** Есть ли более новая несинхронизированная правка той же записи. */
export function hasWaiting(entity: string, ref: string, exceptOperation = ''): boolean {
	return outbox.some(
		(p) =>
			!p.sent &&
			!p.blocked &&
			p.actorId === actorId &&
			p.id !== exceptOperation &&
			p.ref === ref &&
			ENTITY[p.kind] === entity
	);
}

/**
 * Положить запись в очередь. Повторная правка того же полёта заменяет
 * прежнюю посылку: на сервер должно уехать последнее состояние, а не
 * вся история промежуточных нажатий.
 */
export function enqueue(
	kind: Parcel['kind'],
	ref: string,
	payload: unknown,
	action: Parcel['action'] = 'upsert'
) {
	// Нельзя подписывать действие тем, кто не был подтверждён сервером. В UI
	// это состояние недостижимо, но защита нужна при очистке хранилища.
	if (!actorId) return;
	const parcel: Parcel = {
		id: uuid(),
		kind,
		ref,
		payload: structuredClone($state.snapshot(payload)),
		action,
		actorId,
		blocked: '',
		queued: new Date().toISOString(),
		sent: ''
	};

	const waiting = outbox.findIndex(
		(p) => !p.sent && p.actorId === actorId && p.kind === kind && p.ref === ref
	);
	const previous = waiting >= 0 ? outbox[waiting] : undefined;
	// Создали и удалили запись до первой синхронизации — на сервер вообще
	// ничего не уходит, потому что там этой записи никогда не существовало.
	const previousRevision = Number(
		(previous?.payload as { revision?: unknown } | undefined)?.revision ?? 0
	);
	if (
		waiting >= 0 &&
		action === 'delete' &&
		previous?.action === 'upsert' &&
		previousRevision < 1
	) {
		outbox.splice(waiting, 1);
		persistOutbox();
		return;
	}
	if (waiting >= 0) outbox[waiting] = parcel;
	else outbox.push(parcel);
	// The save is deliberately synchronous: after this line the form may close
	// or the phone may suspend the tab without losing the user's change.
	persistOutbox();

	if (net.online) void flush();
}

type SyncAck = {
	operationId: string;
	entity: string;
	recordId: string;
	revision: number;
	action: Parcel['action'];
	data: unknown;
};

type SendResult =
	| { ok: true; revision: number; ack?: SyncAck }
	| { ok: false; blocked?: string; revokeAll?: boolean };

/**
 * Пока одна операция ждёт HTTP-ответа, пользователь может сохранить ту же
 * запись ещё раз. Вторая посылка содержит более новые поля, но собирается со
 * старой ревизией; после первого успеха переносим ей новую базовую ревизию.
 */
function rebaseWaiting(parcel: Parcel, revision: number) {
	if (revision < 1) return;
	for (const waiting of outbox) {
		if (
			waiting === parcel ||
			waiting.sent ||
			waiting.blocked ||
			waiting.actorId !== parcel.actorId ||
			waiting.ref !== parcel.ref ||
			ENTITY[waiting.kind] !== ENTITY[parcel.kind]
		)
			continue;
		const payload = jsonCopy(waiting.payload);
		if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
			(payload as { revision?: number }).revision = revision;
			waiting.payload = payload;
		}
	}
	persistOutbox();
}

async function send(parcel: Parcel): Promise<SendResult> {
	try {
		const entity = ENTITY[parcel.kind];
		const payload = jsonCopy(parcel.payload);
		const res = await api('/sync', {
			method: 'POST',
			body: JSON.stringify({
				operations: [{ id: parcel.id, entity, action: parcel.action, data: payload }]
			})
		});
		const body = (await res.json()) as {
			applied?: { operationId: string; entity: string; recordId: string; revision: number }[];
		};
		const applied = body.applied?.[0];
		if (applied) {
			rebaseWaiting(parcel, applied.revision);
			return {
				ok: true,
				revision: applied.revision,
				ack: { ...applied, action: parcel.action, data: payload }
			};
		}
		return { ok: true, revision: 0 };
	} catch (error) {
		if (error instanceof APIError) {
			const message = error.message;
			return { ok: false, blocked: message, revokeAll: error.status === 401 };
		}
		// связь пропала посреди отправки — посылка остаётся в очереди
		return { ok: false };
	}
}

/** Отправить всё, что накопилось. Вызывается при появлении сети и вручную */
export async function flush() {
	if (!browser || !syncAuthorized || net.sending || !net.online) return;
	net.sending = true;
	try {
		// pending() вычисляется заново после каждого ответа: пользователь мог
		// сохранить эту же запись ещё раз во время предыдущей отправки.
		for (;;) {
			const parcel = pending()[0];
			if (!parcel || !net.online) break;
			const result = await send(parcel);
			if (!result.ok) {
				if (result.blocked) {
					if (result.revokeAll) {
						for (const waiting of pending()) waiting.blocked = result.blocked;
					} else {
						parcel.blocked = result.blocked;
					}
					net.error = result.blocked;
					net.blocked = blocked().length;
					persistOutbox();
					window.dispatchEvent(
						new CustomEvent('ekipazh:sync-conflict', {
							detail: { parcel, message: result.blocked }
						})
					);
				}
				break;
			}
			parcel.sent = new Date().toISOString();
			// The server acknowledgement is durable before any UI listener runs.
			// A rendering failure therefore can never resend an already applied
			// operation with an obsolete revision.
			persistOutbox();
			if (result.ack) {
				try {
					window.dispatchEvent(new CustomEvent('ekipazh:sync-ack', { detail: result.ack }));
				} catch (error) {
					console.error('Cannot apply sync acknowledgement to the view', error);
				}
			}
		}
	} finally {
		net.sending = false;
		// Плашки статуса больше нет в шапке, поэтому очистка не должна зависеть
		// от отдельного клика. Иначе очередь бесконечно росла бы на устройстве.
		clearSent();
	}
}

/** Убрать отправленное: очередь не должна расти бесконечно */
export function clearSent() {
	for (let i = outbox.length - 1; i >= 0; i--) {
		if (outbox[i].sent) outbox.splice(i, 1);
	}
	persistOutbox();
}

/** После ручного разрешения конфликта или выдачи новой ссылки можно повторить очередь. */
export function retryBlocked() {
	for (const parcel of blocked()) parcel.blocked = '';
	net.error = '';
	net.blocked = 0;
	persistOutbox();
	void flush();
}

if (browser) {
	addEventListener('online', () => {
		net.online = true;
		void flush();
	});
	addEventListener('offline', () => (net.online = false));
}
