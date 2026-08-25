import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../setup/server';
import { apiClient } from '../setup/client';

let server: RunningServer;

beforeAll(async () => {
	server = await startServer();
}, 60_000);

afterAll(async () => {
	await server?.stop();
});

describe('admin endpoints are guarded', () => {
	it('rejects /api/admin/logs without any admin credential', async () => {
		const anon = apiClient(server.baseURL);
		const res = await anon.get('/api/admin/logs');
		expect(res.status).toBe(403);
	});

	it('rejects /api/admin/users with a wrong x-admin-secret header', async () => {
		const anon = apiClient(server.baseURL);
		const res = await anon.get('/api/admin/users', { 'x-admin-secret': 'nope-wrong' });
		expect(res.status).toBe(403);
	});

	it('accepts /api/admin/logs with the correct x-admin-secret header', async () => {
		const anon = apiClient(server.baseURL);
		const res = await anon.get('/api/admin/logs', { 'x-admin-secret': server.adminSecret });
		expect(res.ok).toBe(true);
	});

	it('accepts /api/admin/users with the correct x-admin-secret header', async () => {
		const anon = apiClient(server.baseURL);
		const res = await anon.get('/api/admin/users', { 'x-admin-secret': server.adminSecret });
		expect(res.ok).toBe(true);
	});

	it('PUT /api/admin/banner rejects wrong secret, accepts correct one', async () => {
		const anon = apiClient(server.baseURL);
		const bad = await anon.put('/api/admin/banner', { text: 'hi' }, { 'x-admin-secret': 'nope' });
		// In gated mode a wrong admin header falls through to the login-required
		// guard (401). In anonymous mode it would land on the endpoint's own
		// requireAdmin() and return 403. Both are correct "denied" responses.
		expect([401, 403]).toContain(bad.status);
		const ok = await anon.put('/api/admin/banner', { text: 'hi' }, { 'x-admin-secret': server.adminSecret });
		expect(ok.ok).toBe(true);
	});

	it('POST /api/admin/reset requires the x-confirm-reset header even when authed', async () => {
		const anon = apiClient(server.baseURL);
		const noConfirm = await anon.post('/api/admin/reset', {}, { 'x-admin-secret': server.adminSecret });
		expect(noConfirm.status).toBe(400);
		const ok = await anon.post('/api/admin/reset', {}, {
			'x-admin-secret': server.adminSecret,
			'x-confirm-reset': 'yes'
		});
		expect(ok.ok).toBe(true);
	});

	it('admin login via /api/auth/login sets an admin-role cookie that unlocks admin endpoints', async () => {
		const client = apiClient(server.baseURL);
		await client.loginAs('admin', { member: 'test-member-secret', admin: server.adminSecret });
		const res = await client.get('/api/admin/logs');
		expect(res.ok).toBe(true);
	});

	it('member login does NOT unlock admin endpoints', async () => {
		const client = apiClient(server.baseURL);
		await client.loginAs('member', { member: 'test-member-secret', admin: server.adminSecret });
		const res = await client.get('/api/admin/logs');
		expect(res.status).toBe(403);
	});
});
