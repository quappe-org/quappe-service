import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCachedPulse, refreshPulseCache } from '$lib/server/pulse';
import { registerStep } from '$lib/models/fibonacci';

export const GET: RequestHandler = async ({ url, locals }) => {
	const locale = locals.locale;
	const force = url.searchParams.get('force') === 'true';
	const step = registerStep(Number(url.searchParams.get('register')));
	if (!force) {
		const hit = getCachedPulse(locale, step);
		if (hit) return json({ ...hit.body, cached: true });
	}
	const body = await refreshPulseCache(locale, step);
	return json({ ...body, cached: false });
};
