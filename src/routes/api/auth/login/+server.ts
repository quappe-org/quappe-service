import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { timingSafeEqual } from 'node:crypto';
import { setRole } from '$lib/server/identity';
import { authMode, accessSecret, adminSecretValue } from '$lib/server/auth-config';
import { checkAuthRate } from '$lib/server/limits';
import { logger } from '$lib/stores/logger';

// Constant-time secret compare — avoids leaking length/prefix via timing.
// timingSafeEqual throws on length mismatch, so guard that first.
function secretMatches(given: string, expected: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

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
	if (!secret) return json({ error: 'Missing secret', code: 'missing_secret' }, { status: 400 });

	const admin = adminSecretValue();
	const access = accessSecret();
	const ip = getClientAddress();

	if (admin && secretMatches(secret, admin)) {
		setRole(cookies, 'admin');
		logger.info('auth', 'login granted', { role: 'admin', ip });
		return json({ ok: true, role: 'admin' });
	}
	if (access && secretMatches(secret, access)) {
		setRole(cookies, 'member');
		logger.info('auth', 'login granted', { role: 'member', ip });
		return json({ ok: true, role: 'member' });
	}

	// Wrong secret — throttle. Only failures draw a token, so a correct login
	// above never counts against the limit.
	const limited = checkAuthRate(ip, null);
	if (limited) return limited;

	logger.warn('auth', 'login rejected — wrong secret', { ip });
	return json({ error: 'Invalid secret', code: 'invalid_secret' }, { status: 401 });
};
