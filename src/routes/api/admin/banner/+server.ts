import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { prepare } from '$lib/server/db/index';

const BANNER_KEY = 'banner_text';

export const GET: RequestHandler = async () => {
	const row = prepare<{ value: string }>('SELECT value FROM settings WHERE key = ?').get(BANNER_KEY) as { value: string } | undefined;
	return json({ text: row?.value ?? '' });
};

export const PUT: RequestHandler = async ({ request }) => {
	const { text } = await request.json();
	const value = typeof text === 'string' ? text.trim() : '';

	if (value) {
		prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
			.run(BANNER_KEY, value);
	} else {
		prepare('DELETE FROM settings WHERE key = ?').run(BANNER_KEY);
	}

	return json({ text: value });
};
