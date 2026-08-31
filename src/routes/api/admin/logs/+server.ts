import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { tailLogs, logStats, clearLogs, type LogLevel } from '$lib/stores/logger';
import { tierStats } from '$lib/stores/data';
import { requireAdmin } from '$lib/server/admin-auth';

/**
 * GET  /api/admin/logs?since=<seq>&limit=<n>&level=<lvl>&source=<src>
 * Returns log entries newer than `since` (default 0 = all buffered).
 *
 * DELETE clears the buffer. Both require admin.
 */
export const GET: RequestHandler = async ({ url, request, cookies, getClientAddress }) => {
	const denied = requireAdmin(request, cookies, getClientAddress());
	if (denied) return denied;

	const since = Number(url.searchParams.get('since') ?? '0');
	const limit = Math.min(2000, Number(url.searchParams.get('limit') ?? '500'));
	const level = url.searchParams.get('level') as LogLevel | null;
	const source = url.searchParams.get('source');

	let entries = tailLogs(limit, since);
	if (level) entries = entries.filter((e) => e.level === level);
	if (source) entries = entries.filter((e) => e.source === source);

	return json({
		entries,
		stats: logStats(),
		tiers: tierStats()
	});
};

export const DELETE: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const denied = requireAdmin(request, cookies, getClientAddress());
	if (denied) return denied;
	clearLogs();
	return json({ ok: true });
};
