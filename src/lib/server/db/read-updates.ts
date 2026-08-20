import { prepare } from './index.ts';

// Per-user read markers for update events. The event_key is a stable hash of
// the event computed at read time by the /api/reports/updates endpoint.

export function dbGetReadEventKeys(user_id: string): Set<string> {
	const rows = prepare<{ event_key: string }>(
		`SELECT event_key FROM read_updates WHERE user_id = ?`
	).all(user_id) as { event_key: string }[];
	return new Set(rows.map((r) => r.event_key));
}

export function dbMarkUpdatesRead(user_id: string, event_keys: string[], read_at: string): void {
	const stmt = prepare(
		`INSERT INTO read_updates (user_id, event_key, read_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(user_id, event_key) DO NOTHING`
	);
	for (const key of event_keys) stmt.run(user_id, key, read_at);
}

// Housekeeping: drop read markers older than the update window so the table
// doesn't grow unbounded (events past the window never resurface anyway).
export function dbPruneReadUpdates(olderThanIso: string): void {
	prepare(`DELETE FROM read_updates WHERE read_at < ?`).run(olderThanIso);
}
