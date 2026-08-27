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

describe('arguments: thesis-vote gate on create/fork', () => {
	it('blocks a non-voter from adding an argument until they vote on the thesis', async () => {
		// Author creates the thesis (and is auto-upvoted on it at creation).
		const author = apiClient(server.baseURL);
		await author.loginAs('member', { member: memberSecret, admin: adminSecret });

		const thesisRes = await author.post('/api/theses', {
			title: 'Argumente brauchen eine Position auf der These',
			description: 'Wer ein Argument beisteuert, muss sich zur These verhalten.',
			categories: ['economy']
		});
		expect(thesisRes.status).toBe(201);
		const { id: thesisId } = (await thesisRes.json()) as { id: string };

		// A different member who has NOT voted on the thesis tries to contribute.
		const contributor = apiClient(server.baseURL);
		await contributor.loginAs('member', { member: memberSecret, admin: adminSecret });

		const blocked = await contributor.post('/api/arguments', {
			thesis_id: thesisId,
			content: 'Ein pauschales System senkt die Bürokratiekosten deutlich.'
		});
		expect(blocked.status).toBe(403);
		const blockedBody = (await blocked.json()) as { code?: string; thesis_id?: string };
		expect(blockedBody.code).toBe('thesis_vote_required');
		expect(blockedBody.thesis_id).toBe(thesisId);

		// Position on the thesis, then the same create succeeds.
		const voteRes = await contributor.post(`/api/theses/${thesisId}/vote`, { type: 'support' });
		expect(voteRes.ok).toBe(true);

		const created = await contributor.post('/api/arguments', {
			thesis_id: thesisId,
			content: 'Ein pauschales System senkt die Bürokratiekosten deutlich.'
		});
		expect(created.status).toBe(201);
		const arg = (await created.json()) as { id: string; thesis_id: string };
		expect(arg.thesis_id).toBe(thesisId);
	});

	it('lets the thesis author add an argument (auto-voted at creation)', async () => {
		const author = apiClient(server.baseURL);
		await author.loginAs('member', { member: memberSecret, admin: adminSecret });

		const thesisRes = await author.post('/api/theses', {
			title: 'Autor darf direkt argumentieren',
			description: 'Der Autor hat beim Erstellen implizit für die These gestimmt.',
			categories: ['economy']
		});
		const { id: thesisId } = (await thesisRes.json()) as { id: string };

		const created = await author.post('/api/arguments', {
			thesis_id: thesisId,
			content: 'Als Autor stehe ich bereits hinter der These.'
		});
		expect(created.status).toBe(201);
	});
});
