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

// Create a thesis and return its id. Author is auto-upvoted on it at creation,
// which satisfies the vote-first gate for the author themselves.
async function createThesis(client: ApiClient, title: string): Promise<string> {
	const res = await client.post('/api/theses', {
		title,
		description: `${title} — Beschreibung für den Edge-Test.`,
		categories: ['economy']
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

// POST an edge, retrying once on a 429 (shared localhost IP bucket).
async function postEdge(
	client: ApiClient,
	targetId: string,
	sourceId: string
): Promise<Response> {
	let res = await client.post(`/api/theses/${targetId}/edges`, { source_thesis_id: sourceId });
	if (res.status === 429) {
		await new Promise((r) => setTimeout(r, 3_000));
		res = await client.post(`/api/theses/${targetId}/edges`, { source_thesis_id: sourceId });
	}
	return res;
}

describe('thesis edges: vote-first gate on linking a thesis as an argument', () => {
	it('blocks a non-voter from linking until they vote on the target thesis', async () => {
		const author = apiClient(server.baseURL);
		await author.loginAs('member', { member: memberSecret, admin: adminSecret });
		const targetA = await createThesis(author, 'Ziel-These A');

		// A different member who has NOT voted on A, but owns a source thesis B.
		const linker = apiClient(server.baseURL);
		await linker.loginAs('member', { member: memberSecret, admin: adminSecret });
		const sourceB = await createThesis(linker, 'Quell-These B');

		const blocked = await postEdge(linker, targetA, sourceB);
		expect(blocked.status).toBe(403);
		const blockedBody = (await blocked.json()) as { code?: string; thesis_id?: string };
		expect(blockedBody.code).toBe('thesis_vote_required');
		expect(blockedBody.thesis_id).toBe(targetA);

		// Vote on A, then the same link succeeds.
		const voteRes = await linker.post(`/api/theses/${targetA}/vote`, { type: 'support' });
		expect(voteRes.ok).toBe(true);

		const created = await postEdge(linker, targetA, sourceB);
		expect(created.status).toBe(201);
		const edge = (await created.json()) as {
			id: string;
			source_thesis_id: string;
			target_thesis_id: string;
		};
		expect(edge.source_thesis_id).toBe(sourceB);
		expect(edge.target_thesis_id).toBe(targetA);
	});
});

describe('thesis edges: validation + lifecycle', () => {
	let author: ApiClient;
	let targetA: string;
	let sourceB: string;

	beforeAll(async () => {
		author = apiClient(server.baseURL);
		await author.loginAs('member', { member: memberSecret, admin: adminSecret });
		// Author is auto-voted on both at creation, so the gate passes for them.
		targetA = await createThesis(author, 'Validierungs-Ziel A');
		sourceB = await createThesis(author, 'Validierungs-Quelle B');
	}, 30_000);

	it('rejects a self-link', async () => {
		const res = await postEdge(author, targetA, targetA);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe('self_link');
	});

	it('rejects a link whose source thesis does not exist', async () => {
		const res = await postEdge(author, targetA, '00000000-0000-0000-0000-000000000000');
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe('source_missing');
	});

	it('creates the link, rejects the duplicate, and does NOT change the source thesis vote_summary', async () => {
		// Snapshot B's vote_summary before linking — a link must never count as a vote.
		const beforeRes = await author.get(`/api/theses/${sourceB}`);
		const before = (await beforeRes.json()) as { vote_summary: Record<string, number> };

		const created = await postEdge(author, targetA, sourceB);
		expect(created.status).toBe(201);

		// Duplicate (same source, same target) is rejected.
		const dup = await postEdge(author, targetA, sourceB);
		expect(dup.status).toBe(409);
		const dupBody = (await dup.json()) as { code?: string };
		expect(dupBody.code).toBe('edge_exists');

		// B's vote_summary is untouched by the link.
		const afterRes = await author.get(`/api/theses/${sourceB}`);
		const after = (await afterRes.json()) as { vote_summary: Record<string, number> };
		expect(after.vote_summary).toEqual(before.vote_summary);
	});

	it('GET returns the edge hydrated with its source thesis and a companion argument', async () => {
		const res = await author.get(`/api/theses/${targetA}/edges`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			edges: {
				edge: { source_thesis_id: string };
				thesis: { id: string };
				argument?: { linked_thesis_id?: string; content: string; thesis_id: string };
			}[];
		};
		const match = body.edges.find((e) => e.edge.source_thesis_id === sourceB);
		expect(match).toBeDefined();
		expect(match!.thesis.id).toBe(sourceB);
		// Companion argument: a votable stand-in whose content is empty and which
		// points back at the linked thesis B, living on the target thesis A.
		expect(match!.argument).toBeDefined();
		expect(match!.argument!.linked_thesis_id).toBe(sourceB);
		expect(match!.argument!.thesis_id).toBe(targetA);
		expect(match!.argument!.content).toBe('');
	});

	it('excludes the companion argument from GET /api/arguments (no double display)', async () => {
		const res = await author.get(`/api/arguments?thesis_id=${targetA}`);
		expect(res.status).toBe(200);
		const args = (await res.json()) as { linked_thesis_id?: string }[];
		expect(args.find((a) => a.linked_thesis_id)).toBeUndefined();
	});
});

describe('thesis edges: the companion argument is votable, without touching B', () => {
	it('votes on the companion argument via the normal argument path, leaving B unchanged', async () => {
		const author = apiClient(server.baseURL);
		await author.loginAs('member', { member: memberSecret, admin: adminSecret });
		const targetA = await createThesis(author, 'Vote-Ziel A');
		const sourceB = await createThesis(author, 'Vote-Quelle B');

		// Link B onto A (author is auto-voted on A at creation → gate passes).
		const created = await postEdge(author, targetA, sourceB);
		expect(created.status).toBe(201);

		// Pull the companion argument id from the hydrated edge read.
		const listRes = await author.get(`/api/theses/${targetA}/edges`);
		const list = (await listRes.json()) as {
			edges: { edge: { source_thesis_id: string }; argument?: { id: string } }[];
		};
		const companion = list.edges.find((e) => e.edge.source_thesis_id === sourceB)!.argument!;
		expect(companion).toBeDefined();

		// Snapshot B's thesis vote_summary — voting the companion must NOT change it.
		const beforeB = (await (await author.get(`/api/theses/${sourceB}`)).json()) as {
			vote_summary: Record<string, number>;
		};

		const vote = await author.post(`/api/arguments/${companion.id}/vote`, {
			type: 'support',
			weight: 1
		});
		expect(vote.status).toBe(200);
		const voteBody = (await vote.json()) as { vote_summary: { support: number } };
		expect(voteBody.vote_summary.support).toBeGreaterThan(0);

		// B's own thesis vote_summary is untouched — the companion vote is an
		// argument vote, structurally separate from B's thesis scoring.
		const afterB = (await (await author.get(`/api/theses/${sourceB}`)).json()) as {
			vote_summary: Record<string, number>;
		};
		expect(afterB.vote_summary).toEqual(beforeB.vote_summary);
	});

	it('gates voting the companion behind a thesis vote on A', async () => {
		const author = apiClient(server.baseURL);
		await author.loginAs('member', { member: memberSecret, admin: adminSecret });
		const targetA = await createThesis(author, 'Gate-Ziel A');
		const sourceB = await createThesis(author, 'Gate-Quelle B');
		const created = await postEdge(author, targetA, sourceB);
		expect(created.status).toBe(201);
		const companion = (
			(await (await author.get(`/api/theses/${targetA}/edges`)).json()) as {
				edges: { edge: { source_thesis_id: string }; argument?: { id: string } }[];
			}
		).edges.find((e) => e.edge.source_thesis_id === sourceB)!.argument!;

		// A fresh member who never voted on A cannot vote the companion argument.
		const other = apiClient(server.baseURL);
		await other.loginAs('member', { member: memberSecret, admin: adminSecret });
		const blocked = await other.post(`/api/arguments/${companion.id}/vote`, { type: 'support' });
		expect(blocked.status).toBe(403);
		const blockedBody = (await blocked.json()) as { code?: string };
		expect(blockedBody.code).toBe('thesis_vote_required');
	});
});

describe('thesis edges: delete is author-only', () => {
	it('lets the author remove the link but blocks a non-author', async () => {
		const author = apiClient(server.baseURL);
		await author.loginAs('member', { member: memberSecret, admin: adminSecret });
		const targetA = await createThesis(author, 'Lösch-Ziel A');
		const sourceB = await createThesis(author, 'Lösch-Quelle B');

		const created = await postEdge(author, targetA, sourceB);
		expect(created.status).toBe(201);
		const edge = (await created.json()) as { id: string };

		// Grab the companion argument id so we can prove it's gone after unlink.
		const companionId = (
			(await (await author.get(`/api/theses/${targetA}/edges`)).json()) as {
				edges: { edge: { source_thesis_id: string }; argument?: { id: string } }[];
			}
		).edges.find((e) => e.edge.source_thesis_id === sourceB)!.argument!.id;

		// A different member cannot delete someone else's edge.
		const other = apiClient(server.baseURL);
		await other.loginAs('member', { member: memberSecret, admin: adminSecret });
		const forbidden = await other.del(`/api/theses/${targetA}/edges/${edge.id}`);
		expect(forbidden.status).toBe(403);
		const forbiddenBody = (await forbidden.json()) as { code?: string };
		expect(forbiddenBody.code).toBe('not_edge_author');

		// The author can.
		const ok = await author.del(`/api/theses/${targetA}/edges/${edge.id}`);
		expect(ok.status).toBe(200);

		// It's gone.
		const listRes = await author.get(`/api/theses/${targetA}/edges`);
		const list = (await listRes.json()) as { edges: { edge: { id: string } }[] };
		expect(list.edges.find((e) => e.edge.id === edge.id)).toBeUndefined();

		// The companion argument was removed too — voting it now 404s.
		await author.post(`/api/theses/${targetA}/vote`, { type: 'support' });
		const goneVote = await author.post(`/api/arguments/${companionId}/vote`, { type: 'support' });
		expect(goneVote.status).toBe(404);
	});
});
