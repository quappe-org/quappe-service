// Server-side abuse guards: length caps + per-IP + per-user rate limits.
// In-memory, MVP-scale. Bucket state resets on server restart. Domain data
// itself lives in SQLite (.data/quappe.db); only these ephemeral rate buckets
// are in-memory. Daily participation budgets live in src/lib/server/budget.ts.

import { json } from '@sveltejs/kit';
import { DEFAULT_CATEGORIES } from '$lib/models/types';
import { logger } from '$lib/stores/logger';
import { incCounter } from '$lib/server/metrics';

export const LIMITS = {
	thesis_title: 200,
	thesis_description: 2000,
	argument_content: 800,
	search_query: 200,
	category_name: 40,
	max_categories: 8
} as const;

export type FieldName = keyof typeof LIMITS;

/**
 * Validate a string field against its cap. Returns an error Response on
 * violation, or `null` if OK. Also rejects non-strings and empty-after-trim.
 */
export function checkLength(field: FieldName, value: unknown): Response | null {
	if (typeof value !== 'string') {
		return json({ error: `Field "${field}" must be a string` }, { status: 400 });
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return json({ error: `Field "${field}" must not be empty` }, { status: 400 });
	}
	const cap = LIMITS[field];
	if (trimmed.length > cap) {
		return json(
			{ error: `Field "${field}" exceeds ${cap} chars (got ${trimmed.length})` },
			{ status: 413 }
		);
	}
	return null;
}

export function checkCategories(value: unknown): Response | null {
	if (!Array.isArray(value)) {
		return json({ error: 'Field "categories" must be an array' }, { status: 400 });
	}
	if (value.length === 0) {
		return json({ error: 'At least one category is required' }, { status: 400 });
	}
	if (value.length > LIMITS.max_categories) {
		return json(
			{ error: `Too many categories (max ${LIMITS.max_categories})` },
			{ status: 413 }
		);
	}
	const allowed = new Set(DEFAULT_CATEGORIES.map((c) => c.toLowerCase()));
	for (const c of value) {
		if (typeof c !== 'string' || c.trim().length === 0) {
			return json({ error: 'Each category must be a non-empty string' }, { status: 400 });
		}
		if (c.length > LIMITS.category_name) {
			return json(
				{ error: `Category name exceeds ${LIMITS.category_name} chars` },
				{ status: 413 }
			);
		}
		if (!allowed.has(c.trim().toLowerCase())) {
			return json(
				{ error: `Unknown category "${c}". Allowed: ${DEFAULT_CATEGORIES.join(', ')}` },
				{ status: 400 }
			);
		}
	}
	return null;
}

// ---- Rate limiting ----
// Token-bucket per key. Buckets refill at `refillPerSec` up to `capacity`.
// If a request finds an empty bucket, it's rejected with 429.

interface Bucket {
	tokens: number;
	updated: number; // ms epoch
}

interface Policy {
	capacity: number;
	refillPerSec: number;
}

const buckets = new Map<string, Bucket>();

// Sweep old buckets every 5 min so long-running processes don't leak memory.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const BUCKET_TTL_MS = 30 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now: number): void {
	if (now - lastSweep < SWEEP_INTERVAL_MS) return;
	for (const [key, b] of buckets) {
		if (now - b.updated > BUCKET_TTL_MS) buckets.delete(key);
	}
	lastSweep = now;
}

function take(key: string, policy: Policy): boolean {
	const now = Date.now();
	sweep(now);
	let b = buckets.get(key);
	if (!b) {
		b = { tokens: policy.capacity, updated: now };
		buckets.set(key, b);
	} else {
		const elapsed = (now - b.updated) / 1000;
		b.tokens = Math.min(policy.capacity, b.tokens + elapsed * policy.refillPerSec);
		b.updated = now;
	}
	if (b.tokens < 1) return false;
	b.tokens -= 1;
	return true;
}

// Policies tuned for MVP scale. All numbers per key (IP or user).
// "write_heavy" = create thesis / argument (expensive: also triggers embedding)
// "write_light" = vote (cheap, but easy to spam-flood)
// "read"        = search / read endpoints
const POLICIES: Record<string, Policy> = {
	write_heavy: { capacity: 10, refillPerSec: 10 / 60 }, // 10 burst, ~10/min sustained
	write_light: { capacity: 30, refillPerSec: 30 / 60 }, // 30 burst, ~30/min sustained
	read: { capacity: 60, refillPerSec: 60 / 60 }, // 60 burst, ~60/min sustained
	// Auth is deliberately strict: this bucket only ever sees *failed* secret
	// attempts (successful auth never draws a token — see checkAuthRate callers),
	// so a legitimate user costs nothing while a brute-forcer is blocked after 3.
	auth: { capacity: 3, refillPerSec: 3 / 60 } // 3 burst, ~3/min sustained
};

export type RateClass = keyof typeof POLICIES;

/**
 * Rate-limit a request by user_id (primary) and IP (secondary/fallback).
 *
 * Strategy:
 *   - user_id (JWT cookie) is the authoritative key — it cannot be spoofed via
 *     headers. When present, it is checked first and is sufficient on its own.
 *   - IP is checked as a secondary guard: stops unauthenticated hammering and
 *     provides a backstop when the cookie is absent (e.g. pre-identity requests).
 *   - When both are present, BOTH buckets must have tokens — a single identity
 *     can't bypass the IP cap by rotating, and a single IP can't bypass the user
 *     cap by rotating UUIDs.
 *
 * 429 messages name the offending dimension so ops can distinguish session abuse
 * from network-level floods.
 */
export function checkRate(
	ip: string,
	user_id: string | null,
	klass: RateClass
): Response | null {
	const policy = POLICIES[klass];

	// Primary: user_id bucket (JWT-authoritative, not spoofable via headers).
	if (user_id) {
		const userKey = `${klass}:u:${user_id}`;
		if (!take(userKey, policy)) {
			logger.warn('ratelimit', 'user bucket exhausted', { klass, user_id });
			incCounter('quappe_ratelimit_denials_total', 'Rate-limit rejections', { klass, dimension: 'user' });
			return json(
				{ error: 'Too many requests for your session. Slow down.' },
				{ status: 429, headers: { 'Retry-After': '60' } }
			);
		}
	}

	// Secondary: IP bucket (fallback guard; always checked alongside user_id).
	const ipKey = `${klass}:ip:${ip}`;
	if (!take(ipKey, policy)) {
		logger.warn('ratelimit', 'ip bucket exhausted', { klass, ip });
		incCounter('quappe_ratelimit_denials_total', 'Rate-limit rejections', { klass, dimension: 'ip' });
		return json(
			{ error: 'Too many requests from your network. Slow down.' },
			{ status: 429, headers: { 'Retry-After': '60' } }
		);
	}

	return null;
}

/**
 * Rate-limit a *failed* auth attempt (wrong/missing secret). Call this ONLY on
 * the failure path — a successful login or a valid admin-header request must not
 * draw a token, otherwise a legitimate admin polling /api/admin/logs every 2s
 * would lock itself out. Because only failures land here, brute-force (which is
 * by definition a stream of failures) is throttled after `auth.capacity` tries.
 *
 * IP is the primary key (login happens pre-identity); user_id is checked too
 * when present so a single cookie can't rotate IPs to bypass the cap.
 * Returns a 429 Response when the bucket is empty, else null.
 */
export function checkAuthRate(ip: string, user_id: string | null): Response | null {
	const policy = POLICIES.auth;

	if (user_id) {
		if (!take(`auth:u:${user_id}`, policy)) {
			logger.warn('ratelimit', 'auth bucket exhausted', { dimension: 'user', user_id });
			incCounter('quappe_ratelimit_denials_total', 'Rate-limit rejections', { klass: 'auth', dimension: 'user' });
			return json(
				{ error: 'Too many attempts. Slow down.', code: 'rate_limited' },
				{ status: 429, headers: { 'Retry-After': '60' } }
			);
		}
	}

	if (!take(`auth:ip:${ip}`, policy)) {
		logger.warn('ratelimit', 'auth bucket exhausted', { dimension: 'ip', ip });
		incCounter('quappe_ratelimit_denials_total', 'Rate-limit rejections', { klass: 'auth', dimension: 'ip' });
		return json(
			{ error: 'Too many attempts. Slow down.', code: 'rate_limited' },
			{ status: 429, headers: { 'Retry-After': '60' } }
		);
	}

	return null;
}

/**
 * Resolve the client IP for rate-limit keying.
 *
 * In k8s, `X-Forwarded-For` is trivially spoofable by the client unless the
 * ingress strips/overwrites it. We therefore prefer `clientAddress` (set by the
 * SvelteKit adapter from the actual TCP peer, not from headers) and only fall
 * back to `X-Forwarded-For` when `clientAddress` is absent — which only happens
 * in environments where the header is trustworthy (e.g. behind a known proxy
 * that we control). Falls back to 'unknown' so at least one bucket fires. */
export function getClientIp(request: Request, clientAddress: string): string {
	if (clientAddress) return clientAddress;
	const fwd = request.headers.get('x-forwarded-for');
	if (fwd) return fwd.split(',')[0].trim();
	return 'unknown';
}
