// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

type DeferredResponse = {
	resolve: (value: Response) => void;
};

function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, String(value))
	};
}

function response(operationId: string, revision: number) {
	return new Response(
		JSON.stringify({
			acked: [operationId],
			applied: [{ operationId, entity: 'flight', recordId: 'flight-1', revision }]
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}

describe('offline synchronization', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it('rebases a second save made while the first save is in flight', async () => {
		const waiting: DeferredResponse[] = [];
		const fetchMock = vi.fn(
			(_input: RequestInfo | URL, _init?: RequestInit) =>
				new Promise<Response>((resolve) => waiting.push({ resolve }))
		);
		vi.stubGlobal('fetch', fetchMock);
		const local = memoryStorage();
		const session = memoryStorage();
		vi.stubGlobal('localStorage', local);
		vi.stubGlobal('sessionStorage', session);
		local.setItem('ekipazh.access-token', 'test-access-token');
		session.setItem('ekipazh.session-access-token', 'test-access-token');

		const { enqueue, flush, outbox, setSyncActor } = await import('./sync.svelte');
		setSyncActor('pilot-1');
		enqueue('полёт', 'flight-1', { id: 'flight-1', revision: 1, task: 'Первая правка' });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

		// Пользователь сохранил карточку второй раз до ответа сервера.
		enqueue('полёт', 'flight-1', { id: 'flight-1', revision: 1, task: 'Вторая правка' });
		const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		waiting[0].resolve(response(first.operations[0].id, 2));

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
		expect(second.operations[0].data).toMatchObject({
			id: 'flight-1',
			revision: 2,
			task: 'Вторая правка'
		});

		waiting[1].resolve(response(second.operations[0].id, 3));
		await vi.waitFor(() => expect(outbox).toHaveLength(0));
		await flush();
	});

	it('acknowledges an operation even if a view listener fails', async () => {
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			return Promise.resolve(response(body.operations[0].id, 2));
		});
		vi.stubGlobal('fetch', fetchMock);
		const local = memoryStorage();
		const session = memoryStorage();
		vi.stubGlobal('localStorage', local);
		vi.stubGlobal('sessionStorage', session);
		local.setItem('ekipazh.access-token', 'test-access-token');
		session.setItem('ekipazh.session-access-token', 'test-access-token');

		const dispatch = vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
			throw new Error('view update failed');
		});
		const { enqueue, outbox, setSyncActor } = await import('./sync.svelte');
		setSyncActor('pilot-1');
		enqueue('полёт', 'flight-1', { id: 'flight-1', revision: 1, task: 'Правка' });

		await vi.waitFor(() => expect(outbox).toHaveLength(0));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('writes an edit to localStorage before starting network sync', async () => {
		const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
		vi.stubGlobal('fetch', fetchMock);
		const local = memoryStorage();
		const session = memoryStorage();
		vi.stubGlobal('localStorage', local);
		vi.stubGlobal('sessionStorage', session);
		local.setItem('ekipazh.access-token', 'test-access-token');
		session.setItem('ekipazh.session-access-token', 'test-access-token');

		const { enqueue, setSyncActor } = await import('./sync.svelte');
		setSyncActor('pilot-1');
		enqueue('полёт', 'flight-1', { id: 'flight-1', revision: 1, task: 'Офлайн правка' });

		const saved = JSON.parse(local.getItem('ekipazh.data.shared.outbox') ?? '[]');
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({ ref: 'flight-1', actorId: 'pilot-1' });
	});

	it('keeps a blocked local mutation visible to bootstrap reconciliation', async () => {
		const local = memoryStorage();
		const session = memoryStorage();
		vi.stubGlobal('localStorage', local);
		vi.stubGlobal('sessionStorage', session);
		local.setItem('ekipazh.access-token', 'test-access-token');
		session.setItem('ekipazh.session-access-token', 'test-access-token');

		const { enqueue, hasQueued, net, outbox, setSyncActor } = await import('./sync.svelte');
		setSyncActor('pilot-1', false);
		net.online = false;
		enqueue('полёт', 'flight-local', { id: 'flight-local', revision: 0, task: 'Офлайн' });
		outbox[0].blocked = 'record changed on another device';

		expect(hasQueued('flight', 'flight-local')).toBe(true);
	});
});
