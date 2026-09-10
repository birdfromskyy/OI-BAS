import { browser } from '$app/environment';

const TOKEN_KEY = 'ekipazh.access-token';
const SESSION_TOKEN_KEY = 'ekipazh.session-access-token';

export class APIError extends Error {
	constructor(
		message: string,
		public readonly status: number
	) {
		super(message);
		this.name = 'APIError';
	}
}

/** Секрет из выданной ссылки сохраняется только на устройстве пользователя. */
export function accessTokenFromURL(value: string): string {
	try {
		const url = new URL(value);
		// Новые ссылки используют fragment (#access): браузер не отправляет его
		// Caddy, API и внешним сайтам через Referer. Query-параметр оставлен
		// только для уже выданных ссылок предыдущих версий приложения.
		const fromFragment = new URLSearchParams(url.hash.replace(/^#/, '')).get('access');
		return fromFragment ?? url.searchParams.get('access') ?? '';
	} catch {
		return '';
	}
}

export function accessToken(): string {
	if (!browser) return '';
	const url = new URL(location.href);
	const fromLink = accessTokenFromURL(url.toString());
	if (fromLink) {
		// sessionStorage is tab-local: an administrator can verify a newly
		// issued link in another tab without silently losing their own session.
		sessionStorage.setItem(SESSION_TOKEN_KEY, fromLink);
		localStorage.setItem(TOKEN_KEY, fromLink);
		url.searchParams.delete('access');
		if (new URLSearchParams(url.hash.replace(/^#/, '')).has('access')) url.hash = '';
		history.replaceState(null, '', url);
	}
	return sessionStorage.getItem(SESSION_TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY) ?? '';
}

export function rememberAccessToken(value: string) {
	if (!browser) return;
	sessionStorage.setItem(SESSION_TOKEN_KEY, value);
	localStorage.setItem(TOKEN_KEY, value);
}

export function forgetAccessToken() {
	if (!browser) return;
	sessionStorage.removeItem(SESSION_TOKEN_KEY);
	localStorage.removeItem(TOKEN_KEY);
}

export async function api(path: string, init: RequestInit = {}) {
	const token = accessToken();
	if (!token) throw new Error('Откройте приложение по выданной администратором ссылке');
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);
	if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
	const res = await fetch(`/api/v1${path}`, { ...init, headers });
	if (!res.ok)
		throw new APIError(
			(await res.json().catch(() => null))?.error ?? `Ошибка API: ${res.status}`,
			res.status
		);
	return res;
}

export function uuid(): string {
	return crypto.randomUUID();
}
