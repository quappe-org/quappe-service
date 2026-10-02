import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../setup/server';
import { apiClient, type ApiClient } from '../setup/client';

let server: RunningServer;
const memberSecret = 'test-member-secret';
const adminSecret = 'test-admin-secret';

beforeAll(async () => {
	server = await startServer();
}, 60_000);

afterAll(async () => {
	await server?.stop();
});

async function loggedInClient(): Promise<ApiClient> {
	const c = apiClient(server.baseURL);
	await c.loginAs('member', { member: memberSecret, admin: adminSecret });
	return c;
}

async function createThesis(client: ApiClient, title: string): Promise<string> {
	let res = await client.post('/api/theses', {
		title,
		description: `${title} — Beschreibung für den Test.`,
		categories: ['economy']
	});
	if (res.status === 429) {
		await new Promise((r) => setTimeout(r, 7_000));
		res = await client.post('/api/theses', {
			title,
			description: `${title} — Beschreibung für den Test.`,
			categories: ['economy']
		});
	}
	if (res.status !== 201) throw new Error(`createThesis failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { id: string }).id;
}

// The `register` query param is the reader's amount-slider value. The server
// snaps it to a FIB_ARGUMENTS notch and maps it to a 0-4 density step. The exact
// LLM text depends on Ollama (may be unavailable in CI), so these tests assert
// the CONTRACT: the endpoints accept the param, always answer 200 with the
// documented shape, and cache each register variant independently.

describe('/api/reports/pulse — register density param', () => {
	it('answers 200 with the documented shape, with and without register', async () => {
		const c = await loggedInClient();

		const plain = await c.get('/api/reports/pulse');
		expect(plain.status).toBe(200);
		const plainBody = (await plain.json()) as Record<string, unknown>;
		expect(plainBody).toHaveProperty('stats');
		expect(plainBody).toHaveProperty('generated_at');
		expect(plainBody).toHaveProperty('llm');

		for (const register of [1, 3, 8]) {
			const res = await c.get(`/api/reports/pulse?register=${register}`);
			expect(res.status, `register=${register}`).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body).toHaveProperty('stats');
			expect(body).toHaveProperty('llm');
		}
	});

	it('tolerates an out-of-range / invalid register (clamps, still 200)', async () => {
		const c = await loggedInClient();
		for (const register of ['0', '999', 'abc', '']) {
			const res = await c.get(`/api/reports/pulse?register=${register}`);
			expect(res.status, `register=${register}`).toBe(200);
		}
	});
});

describe('/api/reports/me — register density param', () => {
	it('answers 200 with the documented shape, with and without register', async () => {
		const c = await loggedInClient();
		// Give the user some activity so the report isn't the empty-data branch.
		await createThesis(c, 'Register-Report Testthese');

		const plain = await c.get('/api/reports/me');
		expect(plain.status).toBe(200);
		const plainBody = (await plain.json()) as Record<string, unknown>;
		expect(plainBody).toHaveProperty('stats');
		expect(plainBody).toHaveProperty('references');
		expect(plainBody).toHaveProperty('llm');

		for (const register of [1, 8]) {
			const res = await c.get(`/api/reports/me?register=${register}`);
			expect(res.status, `register=${register}`).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body).toHaveProperty('stats');
			expect(body).toHaveProperty('llm');
		}
	});

	it('caches each register variant independently (no cross-contamination)', async () => {
		const c = await loggedInClient();
		await createThesis(c, 'Register-Cache Testthese');

		// First hit at register=1 populates that variant's cache; a second hit
		// serves from it. A hit at register=8 must be its OWN entry — the presence
		// of a register=1 cache entry must not satisfy a register=8 request.
		const a1 = (await (await c.get('/api/reports/me?register=1')).json()) as { cached?: boolean };
		const a1b = (await (await c.get('/api/reports/me?register=1')).json()) as { cached?: boolean };
		expect(a1b.cached, 'second identical-register request should be cached').toBe(true);

		const b8 = (await (await c.get('/api/reports/me?register=8')).json()) as { cached?: boolean };
		expect(b8.cached, 'first request at a different register must NOT be served from the register=1 cache').toBe(false);
		void a1;
	});
});
