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

describe('identity + basic reachability', () => {
	it('mints a quappe_uid cookie on first request', async () => {
		const client = apiClient(server.baseURL);
		const res = await client.get('/api/heat');
		expect(res.ok).toBe(true);
		expect(client.cookies()).toContain('quappe_uid=');
	});

	it('two clients get distinct identities', async () => {
		const a = apiClient(server.baseURL);
		const b = apiClient(server.baseURL);
		await a.get('/api/heat');
		await b.get('/api/heat');
		const aCookie = a.cookies();
		const bCookie = b.cookies();
		expect(aCookie).not.toEqual('');
		expect(bCookie).not.toEqual('');
		expect(aCookie).not.toEqual(bCookie);
	});

	it('reuses the same cookie across requests within a client', async () => {
		const client = apiClient(server.baseURL);
		await client.get('/api/heat');
		const first = client.cookies();
		await client.get('/api/heat');
		expect(client.cookies()).toEqual(first);
	});
});
