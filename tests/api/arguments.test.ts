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

describe('arguments: fork must extend the original', () => {
	// A fork keeps the parent verbatim and adds substance. The server is the
	// contract, so these rules hold no matter what a client sends. One shared
	// parent is seeded once — re-seeding per test would trip the write_heavy
	// rate limit (10-burst per IP), not the fork guard we're actually testing.
	//
	// The whole file shares one IP (localhost), so the write_heavy IP bucket
	// (10 burst, ~10/min refill) is the binding constraint — and rejected forks
	// still spend a token because checkRate runs before the fork guard. Creates
	// that must succeed therefore wait out a refill on 429 and retry, mirroring
	// the convention in updates-self-actions.test.ts. We do NOT weaken the
	// production limiter for tests; the guard under test is the fork rule.
	let author: ReturnType<typeof apiClient>;
	let thesisId: string;
	let parentId: string;
	const parentContent = 'Ein pauschales System senkt die Bürokratiekosten.';

	// POST an argument that is expected to be created; on a 429 wait for the
	// IP bucket to refill (~7s ≈ 1 token at 10/min) and retry once.
	async function postArgExpectCreated(
		client: ReturnType<typeof apiClient>,
		body: Record<string, unknown>
	): Promise<Response> {
		let res = await client.post('/api/arguments', body);
		if (res.status === 429) {
			await new Promise((r) => setTimeout(r, 7_000));
			res = await client.post('/api/arguments', body);
		}
		return res;
	}

	beforeAll(async () => {
		author = apiClient(server.baseURL);
		await author.loginAs('member', { member: memberSecret, admin: adminSecret });

		const thesisRes = await author.post('/api/theses', {
			title: 'Forks müssen erweitern',
			description: 'Ein Fork bewahrt das Original und ergänzt es.',
			categories: ['economy']
		});
		const { id } = (await thesisRes.json()) as { id: string };
		thesisId = id;

		const parentRes = await postArgExpectCreated(author, {
			thesis_id: thesisId,
			content: parentContent
		});
		expect(parentRes.status).toBe(201);
		parentId = ((await parentRes.json()) as { id: string }).id;
	}, 30_000);

	it('rejects a fork that merely echoes the parent', async () => {
		const res = await author.post('/api/arguments', {
			thesis_id: thesisId,
			content: parentContent,
			forked_from_id: parentId
		});
		expect(res.status).toBe(400);
	});

	it('rejects a fork that only adds whitespace to the parent', async () => {
		const res = await author.post('/api/arguments', {
			thesis_id: thesisId,
			content: `${parentContent}   \n\n  `,
			forked_from_id: parentId
		});
		expect(res.status).toBe(400);
	});

	it('rejects a fork that alters the original text', async () => {
		const res = await author.post('/api/arguments', {
			thesis_id: thesisId,
			content: 'Ein GEÄNDERTES System senkt die Kosten. Und hier ist meine Ergänzung.',
			forked_from_id: parentId
		});
		expect(res.status).toBe(400);
	});

	it('accepts a fork that keeps the original and extends it', async () => {
		// Fresh identity: the shared `author` has spent most of its write_heavy
		// burst on the seed + rejection attempts (rejected forks still consume
		// rate budget — checkRate runs before the fork guard). A new member has
		// its own user bucket, but the IP bucket is shared file-wide, so the
		// create still waits out a refill on 429. It must vote on the thesis
		// first to pass the gate.
		const forker = apiClient(server.baseURL);
		await forker.loginAs('member', { member: memberSecret, admin: adminSecret });
		const voteRes = await forker.post(`/api/theses/${thesisId}/vote`, { type: 'support' });
		expect(voteRes.ok).toBe(true);

		const extended = `${parentContent}\n\nZudem entlastet es kleine Betriebe spürbar.`;
		const res = await postArgExpectCreated(forker, {
			thesis_id: thesisId,
			content: extended,
			forked_from_id: parentId
		});
		expect(res.status).toBe(201);
		const arg = (await res.json()) as { forked_from_id?: string };
		expect(arg.forked_from_id).toBe(parentId);
	}, 15_000);
});
