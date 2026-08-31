import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resetAllData } from '$lib/stores/data';
import { requireAdmin } from '$lib/server/admin-auth';
import { logger } from '$lib/stores/logger';

// Full data reset for business instances (per-iteration wipe). Admin-gated.
//   POST { keep_settings?: boolean }  → wipes theses/arguments/votes/etc.
// Requires a confirmation header to avoid accidental fires.
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const denied = requireAdmin(request, cookies, getClientAddress());
	if (denied) return denied;

	// Extra safety: an explicit confirm header, so a stray call can't wipe.
	if (request.headers.get('x-confirm-reset') !== 'yes') {
		return json(
			{ error: 'Reset requires the header x-confirm-reset: yes' },
			{ status: 400 }
		);
	}

	const body = await request.json().catch(() => ({}));
	const keepSettings = body?.keep_settings !== false; // default: keep banner/config
	logger.warn('admin', 'DATA RESET fired', { keep_settings: keepSettings, ip: getClientAddress() });
	resetAllData(keepSettings);
	return json({ ok: true, keep_settings: keepSettings });
};
