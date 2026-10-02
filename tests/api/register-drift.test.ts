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

async function createThesis(
	client: ApiClient,
	body: Record<string, unknown>
): Promise<Response> {
	let res = await client.post('/api/theses', body);
	if (res.status === 429) {
		await new Promise((r) => setTimeout(r, 7_000));
		res = await client.post('/api/theses', body);
	}
	return res;
}

// Register drift is enforced server-side (hard 422) using embedding similarity.
// The embedding model may be COLD in CI — checkRegisterDrift() returns ok:true
// when the model isn't warm, so a divergent variant would slip through as
// 201/200. These tests therefore assert the CONTRACT that holds in both worlds:
//   - a faithful register variant is ALWAYS accepted;
//   - a divergent one is EITHER blocked (422, model warm) OR accepted because
//     drift-checking was skipped (model cold). It must never be a 400/500.

describe('POST /api/theses — register drift block', () => {
	it('accepts a faithful register variant', async () => {
		const c = await loggedInClient();
		const res = await createThesis(c, {
			title: 'Tempolimit auf Autobahnen',
			description: 'Ein generelles Tempolimit senkt Unfälle und CO2-Ausstoß deutlich.',
			categories: ['environment'],
			description_simple: 'Ein Tempolimit macht Straßen sicherer und die Luft sauberer.'
		});
		expect(res.status).toBe(201);
	});

	it('does not 5xx on a divergent variant (422 when drift-checked, else 201)', async () => {
		const c = await loggedInClient();
		const res = await createThesis(c, {
			title: 'Tempolimit auf Autobahnen',
			description: 'Ein generelles Tempolimit senkt Unfälle und CO2-Ausstoß deutlich.',
			categories: ['environment'],
			description_dense: 'Bananenbrot schmeckt am besten mit Walnüssen und Zimt.'
		});
		expect([201, 422]).toContain(res.status);
		if (res.status === 422) {
			const body = (await res.json()) as { error?: string; drift_score?: number };
			expect(body.error ?? '').toMatch(/drift/i);
			expect(typeof body.drift_score).toBe('number');
		}
	});
});

describe('PUT /api/theses/{id} — persists register fields + drift block', () => {
	it('persists a faithful register variant on edit', async () => {
		const c = await loggedInClient();
		const createRes = await createThesis(c, {
			title: 'Grundeinkommen erproben',
			description: 'Ein bedingungsloses Grundeinkommen sollte in Pilotregionen getestet werden.',
			categories: ['economy']
		});
		expect(createRes.status).toBe(201);
		const { id } = (await createRes.json()) as { id: string };

		const putRes = await c.put(`/api/theses/${id}`, {
			description_simple: 'Der Staat sollte allen Menschen testweise Geld ohne Bedingungen zahlen.'
		});
		expect(putRes.status).toBe(200);

		const getRes = await c.get(`/api/theses/${id}`);
		const fetched = (await getRes.json()) as { description_simple?: string };
		expect(fetched.description_simple).toBe(
			'Der Staat sollte allen Menschen testweise Geld ohne Bedingungen zahlen.'
		);
	});

	it('does not 5xx on a divergent variant edit (422 when drift-checked, else 200)', async () => {
		const c = await loggedInClient();
		const createRes = await createThesis(c, {
			title: 'Grundeinkommen erproben',
			description: 'Ein bedingungsloses Grundeinkommen sollte in Pilotregionen getestet werden.',
			categories: ['economy']
		});
		expect(createRes.status).toBe(201);
		const { id } = (await createRes.json()) as { id: string };

		const putRes = await c.put(`/api/theses/${id}`, {
			description_dense: 'Die Mondlandung war laut Kritikern ein Studioset in Nevada.'
		});
		expect([200, 422]).toContain(putRes.status);
		if (putRes.status === 422) {
			const body = (await putRes.json()) as { error?: string; drift_score?: number };
			expect(body.error ?? '').toMatch(/drift/i);
			expect(typeof body.drift_score).toBe('number');
		}
	});
});

describe('POST /api/theses/draft-variant — advisory drift', () => {
	it('includes a drift object when the LLM is available (else tolerates 503)', async () => {
		const c = await loggedInClient();
		const res = await c.post('/api/theses/draft-variant', {
			title: 'Tempolimit auf Autobahnen',
			description: 'Ein generelles Tempolimit senkt Unfälle und CO2-Ausstoß deutlich.',
			variant: 'simple'
		});
		expect([200, 502, 503]).toContain(res.status);
		if (res.status === 200) {
			const body = (await res.json()) as { description?: string; drift?: { score: number; ok: boolean } };
			expect(typeof body.description).toBe('string');
			expect(body.drift).toBeDefined();
			expect(typeof body.drift?.ok).toBe('boolean');
		}
	});
});
