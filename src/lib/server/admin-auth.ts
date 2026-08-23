import { json } from '@sveltejs/kit';

// Admin authorization.
//
// Phase 1 (anonymous instances like quappe.org): a single operator secret,
// `QUAPPE_ADMIN_SECRET`. A request is admin iff it carries that secret in the
// `x-admin-secret` header. If the env var is unset, admin endpoints are
// DISABLED (locked, not open) — safer default than "everyone is admin".
//
// Phase 2 (OIDC/business instances): this is where a role claim from the SSO
// token will also grant admin — added when the auth adapter lands. The call
// sites won't change; only this function grows a second acceptance path.

export function isAdmin(request: Request): boolean {
	const secret = process.env.QUAPPE_ADMIN_SECRET;
	if (!secret) return false; // no secret configured → admin locked
	return request.headers.get('x-admin-secret') === secret;
}

/** Guard helper: returns a 403 Response if not admin, else null. */
export function requireAdmin(request: Request): Response | null {
	if (isAdmin(request)) return null;
	return json({ error: 'Admin access required' }, { status: 403 });
}
