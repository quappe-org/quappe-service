import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/admin-auth';

// A0: event-store read surface (CONTRACT + STUB only).
//
// The durable event/history store is the platform's next foundation
// (quappe-docs/decisions/durable-event-history.md). This endpoint is the thin,
// cursor-paged, read-only surface a tier-2 analytics consumer pulls from
// (quappe-docs/roadmap.md, track A).
//
// Envelope (frozen here): { id, ts, type, subject_id, actor_id?, payload }
//   - `id`  monotonic integer — the paging CURSOR (pass back as ?since=).
//   - `ts`  ISO-8601 — for display/ordering by humans, NOT the cursor.
//   - `type` one of: thesis.created | vote.cast | lifecycle.changed |
//            thesis.archived | import.batch
//
// NOT YET IMPLEMENTED: emission + persistence (track A1) and the real query
// (A2). Until then this returns an empty, contract-shaped page so the OpenAPI
// contract test and any early consumer can bind against a stable shape. History
// starts at the deploy that lands A1 — the cast_at-era past is not back-filled.
export const GET: RequestHandler = async ({ url, request, cookies, getClientAddress }) => {
	const denied = requireAdmin(request, cookies, getClientAddress());
	if (denied) return denied;

	// Parsed now so the contract (and callers) are stable from A0; A2 will use them.
	const since = Math.max(0, Number(url.searchParams.get('since') ?? 0));
	const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 500)));
	void since;
	void limit;

	// A1/A2 will populate `events` from the append-only store and set
	// `next_cursor` to the last id (or null when caught up).
	return json({ events: [], next_cursor: null });
};
