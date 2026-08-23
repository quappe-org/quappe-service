import { json } from '@sveltejs/kit';
import type { Cookies } from '@sveltejs/kit';
import { readRole } from './identity';
import { adminSecretValue } from './auth-config';

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

/** Guard helper: returns a 403 Response if not admin, else null. */
export function requireAdmin(request: Request, cookies?: Cookies): Response | null {
	if (isAdmin(request, cookies)) return null;
	return json({ error: 'Admin access required' }, { status: 403 });
}
