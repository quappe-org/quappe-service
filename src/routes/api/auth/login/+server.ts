import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setRole } from '$lib/server/identity';
import { authMode, accessSecret, adminSecretValue } from '$lib/server/auth-config';
import { logger } from '$lib/stores/logger';

// Operator/member login for gated (business) instances.
//   POST { secret }  →  matches admin secret → role:admin
//                       matches access secret → role:member
//                       else 401
// In anonymous mode this endpoint is a no-op (403) — no login there.
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	if (authMode() !== 'gated') {
		return json({ error: 'Login is disabled on this instance.' }, { status: 403 });
	}

	const body = await request.json().catch(() => ({}));
	const secret = typeof body?.secret === 'string' ? body.secret : '';
	if (!secret) return json({ error: 'Missing secret' }, { status: 400 });

	const admin = adminSecretValue();
	const access = accessSecret();
	const ip = getClientAddress();

	if (admin && secret === admin) {
		setRole(cookies, 'admin');
		logger.info('auth', 'login granted', { role: 'admin', ip });
		return json({ ok: true, role: 'admin' });
	}
	if (access && secret === access) {
		setRole(cookies, 'member');
		logger.info('auth', 'login granted', { role: 'member', ip });
		return json({ ok: true, role: 'member' });
	}
	logger.warn('auth', 'login rejected — wrong secret', { ip });
	return json({ error: 'Invalid secret' }, { status: 401 });
};
