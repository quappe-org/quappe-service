import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setRole } from '$lib/server/identity';
import { authMode, accessSecret, adminSecretValue } from '$lib/server/auth-config';

// Operator/member login for gated (business) instances.
//   POST { secret }  →  matches admin secret → role:admin
//                       matches access secret → role:member
//                       else 401
// In anonymous mode this endpoint is a no-op (403) — no login there.
export const POST: RequestHandler = async ({ request, cookies }) => {
	if (authMode() !== 'gated') {
		return json({ error: 'Login is disabled on this instance.' }, { status: 403 });
	}

	const body = await request.json().catch(() => ({}));
	const secret = typeof body?.secret === 'string' ? body.secret : '';
	if (!secret) return json({ error: 'Missing secret' }, { status: 400 });

	const admin = adminSecretValue();
	const access = accessSecret();

	if (admin && secret === admin) {
		setRole(cookies, 'admin');
		return json({ ok: true, role: 'admin' });
	}
	if (access && secret === access) {
		setRole(cookies, 'member');
		return json({ ok: true, role: 'member' });
	}
	return json({ error: 'Invalid secret' }, { status: 401 });
};
