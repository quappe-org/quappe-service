import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readRole } from '$lib/server/identity';
import { authMode } from '$lib/server/auth-config';

// Lets the web client learn how to behave: which auth mode the instance runs
// in, and the caller's current role. No secrets exposed.
export const GET: RequestHandler = async ({ cookies, locals }) => {
	const mode = authMode();
	const role = readRole(cookies);
	return json({
		mode, // 'anonymous' | 'gated'
		role, // 'admin' | 'member' | null
		user_id: locals.user_id,
		// In gated mode, a caller with no role must log in before using the app.
		needs_login: mode === 'gated' && role === null
	});
};
