import { json } from '@sveltejs/kit';
import type { Cookies } from '@sveltejs/kit';
import { readRole } from './identity';
import { adminSecretValue } from './auth-config';
import { checkAuthRate } from './limits';

// Admin authorization. Two acceptance paths:
//
//   1. Operator secret in the `x-admin-secret` header (works in any mode;
//      how quappe.org's operator and the bridge/tools authenticate).
//   2. A verified `role: admin` in the identity cookie (gated/business mode,
//      set by the login endpoint after presenting the admin secret).
//
// If no admin secret is configured AND the caller has no admin-role cookie,
// admin is DENIED (locked, not open) — the safe default.

export function isAdmin(request: Request, cookies?: Cookies): boolean {
	// Path 1: header secret
	const secret = adminSecretValue();
	if (secret && request.headers.get('x-admin-secret') === secret) return true;

	// Path 2: admin role from the verified cookie
	if (cookies && readRole(cookies) === 'admin') return true;

	return false;
}

/** Guard helper: returns a 403 Response if not admin, else null.
 *
 * Pass `ip` to throttle *failed* checks: a rejected request draws a token from
 * the strict `auth` bucket and, once exhausted, gets a 429 instead of a 403 —
 * this brute-force-hardens the `x-admin-secret` header. A successful check never
 * draws a token, so a legitimate admin (e.g. the /api/admin/logs 2s poll) is
 * never throttled. Omit `ip` to keep the old un-throttled behaviour. */
export function requireAdmin(request: Request, cookies?: Cookies, ip?: string): Response | null {
	if (isAdmin(request, cookies)) return null;
	if (ip) {
		const limited = checkAuthRate(ip, null);
		if (limited) return limited;
	}
	return json({ error: 'Admin access required', code: 'admin_required' }, { status: 403 });
}

