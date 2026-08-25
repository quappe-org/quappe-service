// /my/updates data source — aggregates 3 kinds of notifications:
// 1. New counter-arguments on the user's theses
// 2. Forks of the user's arguments
// 3. Lifecycle transitions on theses the user supported (within last 14 days)
//
// Self-actions (user reacting to their own content) are filtered out.
//
// Response shape:
// - `events` — raw list, one entry per underlying signal (kept for the
//   PUT read-marking flow and for consumers that want the fine grain).
// - `groups` — one aggregated summary per thesis, the shape the personal
//   feed on the web landing renders. A group is unread iff any of its
//   underlying events is unread; marking a group read PUTs all its
//   `event_keys` at once.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getThesesByAuthor,
	getArgumentsByAuthor,
	getArgumentsForThesis,
	getForksOf,
	getThesisById,
	getAllTheses,
	getVotesByUserSince
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

interface UpdateGroup {
	thesis_id: string;
	thesis_title: string;
	last_at: string; // ISO of the newest underlying event — for sorting
	read: boolean; // true only when every underlying event is read
	new_arguments: number; // count of foreign arguments on my thesis in the window
	forks: number; // count of forks of my arguments on this thesis in the window
	lifecycle_state?: string; // most recent transition, if any
	lifecycle_since?: string; // ISO of that transition
	event_keys: string[]; // for PUT-marking the whole group in one call
}

interface UpdatesBody {
	user_id: string;
	generated_at: string;
	events: UpdateEvent[];
	groups: UpdateGroup[];
	counts: {
		forks: number;
		new_arguments: number;
		lifecycle: number;
		total: number; // total events (unchanged for callers watching the raw counter)
		groups: number; // number of aggregated theses (what the badge should count)
		unread: number; // unread events
		unread_groups: number; // theses with at least one unread event
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
	// dated at `state_since`. Skips theses I authored (already covered by 1+2),
	// theses where `state_since` is still the creation timestamp (no actual
	// transition happened yet — just the initial `seedling` stamp), and theses
	// whose transition was triggered by the user's own recent activity (vote
	// or argument within the 5 minutes leading up to `state_since`).
	const SELF_TRIGGER_WINDOW_MS = 5 * 60 * 1000;
	const windowStartIso = new Date(now - WINDOW_MS - SELF_TRIGGER_WINDOW_MS).toISOString();
	const myRecentVotes = getVotesByUserSince(user_id, windowStartIso);
	const myRecentArgs = myArgs;
	function triggeredByMe(thesis_id: string, stateSinceIso: string): boolean {
		const stateSinceMs = new Date(stateSinceIso).getTime();
		if (!Number.isFinite(stateSinceMs)) return false;
		const windowLoMs = stateSinceMs - SELF_TRIGGER_WINDOW_MS;
		for (const v of myRecentVotes) {
			if (v.thesis_id !== thesis_id) continue;
			const t = new Date(v.cast_at).getTime();
			if (Number.isFinite(t) && t >= windowLoMs && t <= stateSinceMs) return true;
		}
		for (const a of myRecentArgs) {
			if (a.thesis_id !== thesis_id) continue;
			const t = new Date(a.meta.created_at).getTime();
			if (Number.isFinite(t) && t >= windowLoMs && t <= stateSinceMs) return true;
		}
		return false;
	}

	for (const t of getAllTheses()) {
		if (t.meta.author_id === user_id) continue;
		const myVote = t.votes.find((v) => v.user_id === user_id && v.type === 'support');
		if (!myVote) continue;
		const stateSince = t.lifecycle.state_since;
		if (!stateSince) continue;
		if (!withinWindow(stateSince)) continue;
		// The initial `seedling` stamp equals the thesis creation timestamp;
		// that's not a real transition and shouldn't ping supporters as news.
		if (stateSince === t.meta.created_at) continue;
		if (triggeredByMe(t.id, stateSince)) continue;
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

	// ---- Groups: one row per thesis, in-place merge of the raw events.
	// `events` is already sorted newest-first, so the first time we see a
	// thesis becomes its `last_at`. For lifecycle we always overwrite (there
	// is at most one lifecycle event per thesis in `events`, and it's the
	// newest transition — see the loop above).
	const byThesis = new Map<string, UpdateGroup>();
	for (const e of events) {
		let g = byThesis.get(e.thesis_id);
		if (!g) {
			g = {
				thesis_id: e.thesis_id,
				thesis_title: e.thesis_title,
				last_at: e.at,
				read: true, // will flip to false if any event is unread
				new_arguments: 0,
				forks: 0,
				event_keys: []
			};
			byThesis.set(e.thesis_id, g);
		}
		g.event_keys.push(e.event_key);
		if (!e.read) g.read = false;
		if (e.at > g.last_at) g.last_at = e.at;
		if (e.kind === 'new_argument') g.new_arguments++;
		else if (e.kind === 'fork') g.forks++;
		else if (e.kind === 'lifecycle') {
			g.lifecycle_state = e.lifecycle_state;
			g.lifecycle_since = e.at;
		}
	}
	const groups = Array.from(byThesis.values()).sort((a, b) =>
		a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0
	);
	const unread_groups = groups.reduce((n, g) => n + (g.read ? 0 : 1), 0);

	return {
		user_id,
		generated_at: new Date().toISOString(),
		events,
		groups,
		counts: {
			forks,
			new_arguments,
			lifecycle,
			total: events.length,
			groups: groups.length,
			unread,
			unread_groups
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
