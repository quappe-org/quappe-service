import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../setup/server';
import { apiClient } from '../setup/client';

// The server boots in gated mode with QUAPPE_ADMIN_SECRET=test-admin-secret and
// QUAPPE_ACCESS_SECRET=test-member-secret (see tests/setup/server.ts).
//
// Rate-limit buckets are in-memory and per-process, keyed by client IP. All test
// clients share 127.0.0.1, so the `auth` bucket is shared across the whole file.
// The `auth` bucket only counts FAILED attempts (capacity 3) — a successful auth
// draws no token. We rely on that to order the describes below:
//   1. the "successful poll never throttles" regression runs first (0 tokens),
//   2. then the failure-throttle test starts against a full bucket.

let server: RunningServer;

beforeAll(async () => {
	server = await startServer();
}, 60_000);

afterAll(async () => {
	await server?.stop();
});

describe('successful auth never draws an auth token (log-poll stays free)', () => {
	it('repeated correct x-admin-secret GETs stay 200 and never hit 429', async () => {
		const admin = apiClient(server.baseURL);
		// Simulate the /admin/logs 2s poll: many rapid authed reads in a row.
		for (let i = 0; i < 12; i++) {
			const res = await admin.get('/api/admin/logs', { 'x-admin-secret': server.adminSecret });
			expect(res.status).toBe(200);
		}
	});
});

describe('failed auth attempts are throttled after 3', () => {
	it('login with a wrong secret returns 401 with code:invalid_secret, then 429 after the cap', async () => {
		const client = apiClient(server.baseURL);

		// The auth bucket has capacity 3. The first 3 wrong-secret logins each draw
		// a token and return 401; the 4th finds an empty bucket and returns 429.
		const statuses: number[] = [];
		const bodies: Array<{ error?: string; code?: string }> = [];
		for (let i = 0; i < 4; i++) {
			const res = await client.post('/api/auth/login', { secret: 'definitely-wrong' });
			statuses.push(res.status);
			bodies.push(await res.json().catch(() => ({})));
		}

		expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
		expect(bodies[0].code).toBe('invalid_secret');

		expect(statuses[3]).toBe(429);
		expect(bodies[3].code).toBe('rate_limited');
	});

	it('a CORRECT secret still succeeds even after the failure bucket is drained', async () => {
		// The login handler matches the secret BEFORE consulting the auth bucket,
		// so a legitimate login returns 200 and draws no token — even from an IP
		// that just exhausted its failure budget. This is deliberate: brute-force
		// (a stream of failures) is throttled, but the real user is never locked
		// out by someone else hammering the same IP.
		const client = apiClient(server.baseURL);
		const res = await client.post('/api/auth/login', { secret: server.adminSecret });
		expect(res.status).toBe(200);
		const body = await res.json().catch(() => ({}));
		expect(body.role).toBe('admin');
	});
});
