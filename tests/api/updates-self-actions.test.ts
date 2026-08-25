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
	const res = await client.post('/api/theses', {
		title,
		description: `${title} — Beschreibung für den Test.`,
		categories: ['economy']
	});
	if (res.status !== 201) throw new Error(`createThesis failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { id: string }).id;
}

async function addArgument(client: ApiClient, thesis_id: string, content: string): Promise<string> {
	const res = await client.post('/api/arguments', { thesis_id, content });
	if (res.status === 429) {
		// Rate-limit refill is 10/min shared per IP. Wait it out and retry once.
		await new Promise((r) => setTimeout(r, 7_000));
		const retry = await client.post('/api/arguments', { thesis_id, content });
		if (retry.status !== 201) throw new Error(`addArgument retry failed: ${retry.status} ${await retry.text()}`);
		return ((await retry.json()) as { id: string }).id;
	}
	if (res.status !== 201) throw new Error(`addArgument failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { id: string }).id;
}

async function vote(client: ApiClient, thesis_id: string, type: 'support' | 'reject' | 'neutral'): Promise<void> {
	const res = await client.post(`/api/theses/${thesis_id}/vote`, { type, weight: 1 });
	if (!res.ok) throw new Error(`vote failed: ${res.status} ${await res.text()}`);
}

async function getUpdates(client: ApiClient): Promise<{ events: Array<{ kind: string; thesis_id: string; argument_id?: string }>; counts: { total: number } }> {
	const res = await client.get('/api/reports/updates');
	if (!res.ok) throw new Error(`updates failed: ${res.status}`);
	return (await res.json()) as { events: Array<{ kind: string; thesis_id: string; argument_id?: string }>; counts: { total: number } };
}

describe('/api/reports/updates — self-actions filter (Bug 2 reproducer)', () => {
	it('does NOT show my own argument on my own thesis in my updates feed', async () => {
		const alice = await loggedInClient();
		const thesisId = await createThesis(alice, 'Selbst-Argument darf nicht in meinem Feed sein');
		const argId = await addArgument(alice, thesisId, 'Ich ergänze mein eigenes Argument.');

		const feed = await getUpdates(alice);
		const selfEvent = feed.events.find((e) => e.argument_id === argId);
		expect(selfEvent, 'own argument should be filtered from own feed').toBeUndefined();
	});

	it('shows a foreign argument on my thesis in my updates feed', async () => {
		const alice = await loggedInClient();
		const bob = await loggedInClient();
		const thesisId = await createThesis(alice, 'Fremdes Argument muss auftauchen');
		const bobArgId = await addArgument(bob, thesisId, 'Ich (Bob) ergänze das mal.');

		const feed = await getUpdates(alice);
		const event = feed.events.find((e) => e.argument_id === bobArgId);
		expect(event, "foreign argument on Alice's thesis should appear in Alice's feed").toBeDefined();
		expect(event?.kind).toBe('new_argument');
	});

	it('does NOT show a lifecycle transition on a thesis when I triggered it myself', async () => {
		const alice = await loggedInClient();
		const bob = await loggedInClient();
		const thesisId = await createThesis(alice, 'Lifecycle-Trigger sollte nicht als News auftauchen');

		// Bob supports Alice's thesis (so lifecycle events on this thesis
		// would normally show in Bob's feed).
		await vote(bob, thesisId, 'support');

		// Bob himself triggers state-changing activity — arguments that will
		// nudge the thesis lifecycle. In practice, the resulting lifecycle
		// transition is caused by Bob's own actions, so Bob shouldn't see it
		// as "news".
		for (let i = 0; i < 5; i++) {
			await addArgument(bob, thesisId, `Bob-Argument ${i} zur These.`);
		}

		const feed = await getUpdates(bob);
		const selfTriggered = feed.events.find(
			(e) => e.kind === 'lifecycle' && e.thesis_id === thesisId
		);
		expect(selfTriggered, 'lifecycle event triggered by my own recent action should be filtered').toBeUndefined();
	});
});
