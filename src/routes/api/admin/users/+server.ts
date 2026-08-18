import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dbCountDistinctVoters, dbDailyVoterStats } from '$lib/server/db/votes';

export const GET: RequestHandler = async ({ url }) => {
	const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30)));
	const total_users = dbCountDistinctVoters();
	const daily = dbDailyVoterStats(days);
	return json({ total_users, daily });
};
