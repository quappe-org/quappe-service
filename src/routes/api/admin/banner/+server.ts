import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { prepare } from '$lib/server/db/index';
import { requireAdmin } from '$lib/server/admin-auth';

const BANNER_KEY = 'banner_text';

// Shown until an admin sets (or explicitly clears) the banner. Clearing stores
// an empty-string sentinel so we can tell "never touched" apart from "hidden".
const DEFAULT_BANNER =
	'This is an early prototype — feel free to play. All data will be reset before launch. Feedback welcome as a GitHub issue: github.com/quappe-org/quappe-service/issues';

// GET stays public — every client reads the banner to display it.
export const GET: RequestHandler = async () => {
	const row = prepare<{ value: string }>('SELECT value FROM settings WHERE key = ?').get(BANNER_KEY) as { value: string } | undefined;
	// No row at all → never configured → show the default prototype notice.
	const text = row === undefined ? DEFAULT_BANNER : row.value;
	return json({ text });
};

// PUT requires admin — setting/clearing the site-wide banner is an operator action.
export const PUT: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const denied = requireAdmin(request, cookies, getClientAddress());
	if (denied) return denied;

	const { text } = await request.json();
	const value = typeof text === 'string' ? text.trim() : '';

	// Always store a row (even empty) so an explicit clear hides the default.
	prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
		.run(BANNER_KEY, value);

	return json({ text: value });
};
