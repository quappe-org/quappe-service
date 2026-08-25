import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../setup/server';
import { apiClient } from '../setup/client';

let server: RunningServer;
const memberSecret = 'test-member-secret';
const adminSecret = 'test-admin-secret';

beforeAll(async () => {
	server = await startServer();
}, 60_000);

afterAll(async () => {
	await server?.stop();
});

describe('theses CRUD (happy path)', () => {
	it('creates, reads, edits, deletes a thesis', async () => {
		const client = apiClient(server.baseURL);
		await client.loginAs('member', { member: memberSecret, admin: adminSecret });

		const createRes = await client.post('/api/theses', {
			title: 'Radikale Vereinfachung des Steuersystems',
			description: 'Ein pauschales System reduziert Bürokratie und Fehler.',
			categories: ['economy']
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as { id: string; title: string };
		expect(created.id).toBeTruthy();

		const getRes = await client.get(`/api/theses/${created.id}`);
		expect(getRes.ok).toBe(true);
		const fetched = (await getRes.json()) as { id: string; title: string };
		expect(fetched.title).toBe('Radikale Vereinfachung des Steuersystems');

		const editRes = await client.put(`/api/theses/${created.id}`, {
			title: 'Radikale Vereinfachung des Steuersystems (überarbeitet)'
		});
		expect(editRes.ok).toBe(true);

		const delRes = await client.del(`/api/theses/${created.id}`);
		expect([200, 204]).toContain(delRes.status);

		const gone = await client.get(`/api/theses/${created.id}`);
		expect(gone.status).toBe(404);
	});

	it('rejects thesis creation without login in gated mode', async () => {
		const anon = apiClient(server.baseURL);
		const res = await anon.post('/api/theses', {
			title: 'Kein Login sollte 401 geben',
			description: 'Ohne Cookie-Login kein Schreibzugriff.',
			categories: ['economy']
		});
		expect(res.status).toBe(401);
	});

	it('rejects thesis creation with missing fields', async () => {
		const client = apiClient(server.baseURL);
		await client.loginAs('member', { member: memberSecret, admin: adminSecret });
		const res = await client.post('/api/theses', { title: 'nur title' });
		expect(res.status).toBe(400);
	});
});
