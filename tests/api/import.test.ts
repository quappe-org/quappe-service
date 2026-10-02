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

// The bridge sends the source repo as the category (e.g. cc/documentation-customer).
// That is deliberately NOT in DEFAULT_CATEGORIES; the import path must keep it
// rather than coercing to 'other', and GET /api/categories must surface it so the
// feed's filter axis reflects what was actually imported.
describe('import categories are not coerced to the default whitelist', () => {
	it('keeps a non-default category and exposes it via /api/categories', async () => {
		const client = apiClient(server.baseURL);
		const repoCategory = 'cc/documentation-customer';

		const importRes = await client.post(
			'/api/import/theses',
			{
				theses: [
					{
						external_ref: 'github:cc/documentation-customer#1',
						title: 'Docs: clarify onboarding',
						description: 'The onboarding page skips the token step.',
						categories: [repoCategory],
						hashtags: ['bug', 'in-progress'],
						archived: false
					}
				]
			},
			{ 'x-import-secret': server.importSecret }
		);
		expect(importRes.status).toBe(200);
		const summary = (await importRes.json()) as { created: number; total: number };
		expect(summary.created).toBe(1);

		// The imported thesis retains the repo category (not 'other').
		const listRes = await client.get(
			`/api/import/theses?source=${encodeURIComponent('github:cc/documentation-customer')}`,
			{ 'x-import-secret': server.importSecret }
		);
		expect(listRes.ok).toBe(true);

		// The derived category list surfaces the repo name.
		const catRes = await client.get('/api/categories');
		expect(catRes.ok).toBe(true);
		const { categories } = (await catRes.json()) as { categories: string[] };
		expect(categories).toContain(repoCategory);
		expect(categories).not.toContain('other');
	});
});
