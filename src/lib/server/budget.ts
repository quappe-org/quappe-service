// Server-side budget: the single source of truth for daily participation limits.
//
// Vision (.project): participation is a currency. Daily buckets, each a Fibonacci
// value, resetting at local (UTC) midnight:
//   - new theses (8)
//   - arguments (16 — arguments are directionless; one shared pool)
// Reading, exploring and base voting (weight 1) are free. Only extra vote
// WEIGHT costs from a separate weight pool — a strong opinion must be paid for.
//
// This module both REPORTS the current spend and ENFORCES it before a write.
// The client store (budget.svelte.ts) is now only an optimistic mirror; the
// authority lives here.

import { json } from '@sveltejs/kit';
import type { Cookies } from '@sveltejs/kit';
import { getThesesByAuthor, getArgumentsByAuthor, getVotesByUserSince } from '$lib/stores/data';
import { identityAgeMs } from '$lib/server/identity';

// Fibonacci-flavoured daily limits.
export const BUDGET = {
	theses_per_day: 8,
	arguments_per_day: 16,
	// Extra weight points a user may spend per day (base weight-1 votes are free).
	weight_points_per_day: 21
} as const;

export type BudgetBucket = 'thesis' | 'argument';

export interface BudgetStatus {
	date: string;
	theses: { spent: number; limit: number; remaining: number };
	arguments: { spent: number; limit: number; remaining: number };
	weight_points: { spent: number; limit: number; remaining: number };
}

export function todayStartIso(): { dateOnly: string; iso: string } {
	const now = new Date();
	const dateOnly = now.toISOString().split('T')[0];
	return { dateOnly, iso: `${dateOnly}T00:00:00.000Z` };
}

// Compute today's spend for a user across all buckets.
export function getBudgetStatus(user_id: string): BudgetStatus {
	const { dateOnly, iso: sinceIso } = todayStartIso();

	const theses = getThesesByAuthor(user_id).filter((t) => t.meta.created_at >= sinceIso).length;

	const args = getArgumentsByAuthor(user_id).filter((a) => a.meta.created_at >= sinceIso).length;

	// Extra weight points spent today: sum of (weight - 1) over support/reject votes.
	const votes = getVotesByUserSince(user_id, sinceIso).filter(
		(v) => v.vote_type === 'support' || v.vote_type === 'reject'
	);
	let weightPoints = 0;
	for (const v of votes) weightPoints += Math.max(0, v.weight - 1);

	return {
		date: dateOnly,
		theses: mk(theses, BUDGET.theses_per_day),
		arguments: mk(args, BUDGET.arguments_per_day),
		weight_points: mk(weightPoints, BUDGET.weight_points_per_day)
	};
}

function mk(spent: number, limit: number) {
	return { spent, limit, remaining: Math.max(0, limit - spent) };
}

// Enforcement guards. Return an error Response (HTTP 429) when the bucket is
// exhausted, or null when the action is allowed. Call BEFORE performing the write.

export function checkThesisBudget(user_id: string): Response | null {
	const s = getBudgetStatus(user_id);
	if (s.theses.remaining <= 0) {
		return json(
			{ error: 'Daily thesis budget reached. Come back tomorrow — input should have value.' },
			{ status: 429 }
		);
	}
	return null;
}

export function checkArgumentBudget(user_id: string): Response | null {
	const s = getBudgetStatus(user_id);
	if (s.arguments.remaining <= 0) {
		return json(
			{ error: 'Daily argument budget reached. Come back tomorrow — input should have value.' },
			{ status: 429 }
		);
	}
	return null;
}

// A vote's base weight (1) is always free. Only the extra weight beyond 1 draws
// from the daily weight pool. `alreadySpentOnThisTarget` lets a re-vote on the
// same target reclaim its previous extra weight so cycling isn't double-charged.
export function checkWeightBudget(
	user_id: string,
	requestedWeight: number,
	alreadySpentOnThisTarget = 0
): Response | null {
	const extra = Math.max(0, requestedWeight - 1);
	if (extra <= 0) return null; // base vote is free
	const s = getBudgetStatus(user_id);
	const netNeeded = extra - Math.max(0, alreadySpentOnThisTarget - 0);
	if (netNeeded > s.weight_points.remaining) {
		return json(
			{ error: 'Daily weight budget reached — base votes are still free.' },
			{ status: 429 }
		);
	}
	return null;
}

// Sybil dampener: a freshly-minted identity may not immediately cast weighted
// votes. Someone clearing cookies to spin up a fresh id gets a base (weight-1)
// voice only until the identity has aged past this threshold. Base votes and
// creation remain allowed — this only blocks concentrated influence-buying.
const MIN_IDENTITY_AGE_FOR_WEIGHT_MS = 60_000; // 1 minute

export function checkIdentityMaturityForWeight(
	cookies: Cookies,
	requestedWeight: number
): Response | null {
	if (requestedWeight <= 1) return null; // base votes always allowed
	if (identityAgeMs(cookies) < MIN_IDENTITY_AGE_FOR_WEIGHT_MS) {
		return json(
			{ error: 'New identities can cast base votes only for the first minute.' },
			{ status: 429 }
		);
	}
	return null;
}
