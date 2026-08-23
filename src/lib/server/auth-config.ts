// Instance auth configuration — the single switch that makes one codebase serve
// two worlds:
//
//   AUTH_MODE=anonymous  (default, e.g. quappe.org)
//     Everyone gets an anonymous identity automatically. No login. This is the
//     consumer/public mode where anonymity is a feature.
//
//   AUTH_MODE=gated  (e.g. an internal business instance)
//     Users must present the access secret once to obtain a `member` identity;
//     the admin secret grants `role: admin`. Read/write still uses the same
//     anonymous-JWT machinery underneath — only a gate is added in front.
//
// Secrets:
//   QUAPPE_ACCESS_SECRET — grants `member` (only meaningful in gated mode)
//   QUAPPE_ADMIN_SECRET  — grants `admin` (both modes; also guards /api/admin/*)

export type AuthMode = 'anonymous' | 'gated';

export function authMode(): AuthMode {
	return process.env.AUTH_MODE === 'gated' ? 'gated' : 'anonymous';
}

export function accessSecret(): string | null {
	const s = process.env.QUAPPE_ACCESS_SECRET;
	return s && s.length > 0 ? s : null;
}

export function adminSecretValue(): string | null {
	const s = process.env.QUAPPE_ADMIN_SECRET;
	return s && s.length > 0 ? s : null;
}
