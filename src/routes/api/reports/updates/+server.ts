// /my/updates data source — aggregates 3 kinds of notifications:
// 1. New counter-arguments on the user's theses
// 2. Forks of the user's arguments
// 3. Lifecycle transitions on theses the user supported (within last 14 days)
//
// Self-actions (user reacting to their own content) are filtered out.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getThesesByAuthor,
	getArgumentsByAuthor,
	getArgumentsForThesis,
	getForksOf,
	getThesisById,
	getAllTheses
} from '$lib/stores/data';
import { dbGetReadEventKeys, dbMarkUpdatesRead } from '$lib/server/db/read-updates';

type UpdateKind = 'fork' | 'new_argument' | 'lifecycle';

interface UpdateEvent {
	kind: UpdateKind;
	event_key: string; // stable id for read-tracking
	read: boolean;
	at: string;
	thesis_id: string;
	thesis_title: string;
	// fork
	original_argument_id?: string;
	original_content?: string;
	original_votes?: number;
	fork_argument_id?: string;
	fork_content?: string;
	fork_votes?: number;
	// new_argument
	argument_id?: string;
	argument_content?: string;
	// lifecycle
	lifecycle_state?: string;
}

interface UpdatesBody {
	user_id: string;
	generated_at: string;
	events: UpdateEvent[];
	counts: {
		forks: number;
		new_arguments: number;
		lifecycle: number;
		total: number;
		unread: number;
	};
}

// Deterministic key for an event so read-state survives re-aggregation.
// Must be reproducible from the event's identifying fields alone.
function eventKey(e: { kind: UpdateKind; thesis_id: string; at: string; fork_argument_id?: string; argument_id?: string; lifecycle_state?: string }): string {
	if (e.kind === 'fork') return `fork:${e.fork_argument_id}`;
	if (e.kind === 'new_argument') return `arg:${e.argument_id}`;
	return `life:${e.thesis_id}:${e.lifecycle_state}:${e.at}`;
}

function snip(s: string, n = 140): string {
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function aggregate(user_id: string): UpdatesBody {
	const myTheses = getThesesByAuthor(user_id);
	const myArgs = getArgumentsByAuthor(user_id);
	const events: UpdateEvent[] = [];
	const now = Date.now();
	const withinWindow = (iso: string): boolean => {
		const t = new Date(iso).getTime();
		return Number.isFinite(t) && now - t <= WINDOW_MS;
	};

	// 1. Forks of my arguments
	for (const a of myArgs) {
		for (const fork of getForksOf(a.id)) {
			if (fork.meta.author_id === user_id) continue;
			if (!withinWindow(fork.meta.created_at)) continue;
			const parent = getThesisById(fork.thesis_id);
			const originalVotes = a.votes.reduce((s, v) => s + (v.type === 'support' ? v.weight : 0), 0);
			const forkVotes = fork.votes.reduce((s, v) => s + (v.type === 'support' ? v.weight : 0), 0);
			events.push({
				kind: 'fork',
				event_key: '',
				read: false,
				at: fork.meta.created_at,
				thesis_id: fork.thesis_id,
				thesis_title: parent?.title ?? '(unknown)',
				original_argument_id: a.id,
				original_content: snip(a.content),
				original_votes: originalVotes,
				fork_argument_id: fork.id,
				fork_content: snip(fork.content),
				fork_votes: forkVotes
			});
		}
	}

	// 2. New arguments on my theses
	for (const t of myTheses) {
		for (const a of getArgumentsForThesis(t.id)) {
			if (a.meta.author_id === user_id) continue;
			if (!withinWindow(a.meta.created_at)) continue;
			events.push({
				kind: 'new_argument',
				event_key: '',
				read: false,
				at: a.meta.created_at,
				thesis_id: t.id,
				thesis_title: t.title,
				argument_id: a.id,
				argument_content: snip(a.content)
			});
		}
	}

	// 3. Lifecycle transitions on theses I supported. One entry per thesis,
	// dated at `state_since`. Skips theses I authored (already covered by 1+2).
	for (const t of getAllTheses()) {
		if (t.meta.author_id === user_id) continue;
		const myVote = t.votes.find((v) => v.user_id === user_id && v.type === 'support');
		if (!myVote) continue;
		const stateSince = t.lifecycle.state_since;
		if (!stateSince) continue;
		if (!withinWindow(stateSince)) continue;
		events.push({
			kind: 'lifecycle',
			event_key: '',
			read: false,
			at: stateSince,
			thesis_id: t.id,
			thesis_title: t.title,
			lifecycle_state: t.lifecycle.state
		});
	}

	events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

	// Stamp keys + read state from the persisted markers.
	const readKeys = dbGetReadEventKeys(user_id);
	let unread = 0;
	for (const e of events) {
		e.event_key = eventKey(e);
		e.read = readKeys.has(e.event_key);
		if (!e.read) unread++;
	}

	let forks = 0,
		new_arguments = 0,
		lifecycle = 0;
	for (const e of events) {
		if (e.kind === 'fork') forks++;
		else if (e.kind === 'new_argument') new_arguments++;
		else if (e.kind === 'lifecycle') lifecycle++;
	}

	return {
		user_id,
		generated_at: new Date().toISOString(),
		events,
		counts: {
			forks,
			new_arguments,
			lifecycle,
			total: events.length,
			unread
		}
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	return json(aggregate(locals.user_id));
};

// Mark update events as read. Body: { event_keys: string[] }.
export const PUT: RequestHandler = async ({ request, locals }) => {
	const body = await request.json().catch(() => ({}));
	const keys = Array.isArray(body?.event_keys) ? body.event_keys.filter((k: unknown) => typeof k === 'string') : [];
	if (keys.length > 0) {
		dbMarkUpdatesRead(locals.user_id, keys, new Date().toISOString());
	}
	return json({ ok: true, marked: keys.length });
};
