import { describe, expect, it } from 'vitest';

import { accessTokenFromURL } from './api';

describe('accessTokenFromURL', () => {
	it('reads a token from a fragment without requiring a server-visible query', () => {
		expect(accessTokenFromURL('https://oi-bas.space/#access=secure-token')).toBe('secure-token');
	});

	it('keeps compatibility with old query-string links', () => {
		expect(accessTokenFromURL('https://oi-bas.space/?access=old-token')).toBe('old-token');
	});

	it('rejects malformed input', () => {
		expect(accessTokenFromURL('not a URL')).toBe('');
	});
});
