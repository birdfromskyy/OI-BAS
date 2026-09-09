import { browser } from '$app/environment';
import { accessToken, api, forgetAccessToken } from '$lib/api';
import { setSyncActor } from '$lib/sync.svelte';
import type { Profile } from '$lib/mocs/profile';
import { can, ROUTE_RIGHTS, type Action, type Role, type Scope } from '$lib/roles';

/** The access link is the credential. Only its SHA-256 digest is held by PostgreSQL. */
const EMPTY: Profile = { id: '', name: '', roles: [], phone: '', status: '', timezone: '' };
const PROFILE_CACHE = 'ekipazh.cached-profile';

function cachedProfile(): Profile {
	if (!browser) return EMPTY;
	try {
		const saved = JSON.parse(localStorage.getItem(PROFILE_CACHE) ?? '') as {
			token?: string;
			profile?: Profile;
		};
		// Кэш допускается только для той же персональной ссылки. Новый человек,
		// открывший приложение на этом телефоне, не увидит чужие права офлайн.
		return saved.token === accessToken() && saved.profile?.id ? saved.profile : EMPTY;
	} catch {
		return EMPTY;
	}
}

function cacheProfile(profile: Profile) {
	if (!browser) return;
	try {
		localStorage.setItem(PROFILE_CACHE, JSON.stringify({ token: accessToken(), profile }));
	} catch {
		// Закрытое localStorage не должно останавливать работу в открытой вкладке.
	}
}

export const me = $state<Profile>({ ...cachedProfile() });
if (me.id) setSyncActor(me.id);
export const session = $state({ ready: false, error: '' });

export function signedIn(): boolean {
	return accessToken() !== '' && me.id !== '';
}
export function active(): boolean {
	return me.status === 'активен';
}
export function may(action: Action, scope: Scope, own?: boolean): boolean {
	return signedIn() && active() && can(me.roles, action, scope, { own });
}
export function mine(row: { pilotId?: string } | undefined): boolean {
	return row?.pilotId === me.id;
}
export function mayOpen(path: string): boolean {
	const right = ROUTE_RIGHTS[path];
	return right ? may(right[0], right[1]) : signedIn() && active();
}
export function isMe(role: Role): boolean {
	return me.roles.includes(role);
}
export function signature(): string {
	return `${me.name}, ${new Date().toLocaleString('ru-RU')}`;
}
export function applyProfile(profile: Profile) {
	Object.assign(me, profile);
	cacheProfile(me);
	setSyncActor(me.id);
}
export async function updateProfile(input: { name: string; phone: string }) {
	await api('/me', { method: 'PUT', body: JSON.stringify(input) });
	applyProfile({ ...me, ...input });
}

/** Forget only this browser's credential. It does not revoke a user link. */
export function signOut() {
	if (browser) forgetAccessToken();
	if (browser) localStorage.removeItem(PROFILE_CACHE);
	setSyncActor('');
	Object.assign(me, EMPTY);
}

// Compatibility exports used by the existing route components. Authentication
// happens only by opening a permanent server-issued link.
export function signIn(profile: Profile) {
	applyProfile(profile);
	return accessToken();
}
export function revokeFor(_userId: string) {
	/* link revocation is server-side */
}
