import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { voteOnArgument, computeVoteSummary, getArgumentById, hasUserVotedOnThesis } from '$lib/stores/data';
import { checkRate, getClientIp } from '$lib/server/limits';
import { normalizeVoteWeight } from '$lib/models/fibonacci';
import { checkWeightBudget, checkIdentityMaturityForWeight } from '$lib/server/budget';

export const POST: RequestHandler = async ({ params, request, getClientAddress, locals, cookies }) => {
	const body = await request.json();
	const { type, weight } = body;
	const user_id = locals.user_id;

	const ip = getClientIp(request, getClientAddress());
	const rate = checkRate(ip, user_id, 'write_light');
	if (rate) return rate;

	if (!type || !['support', 'reject'].includes(type)) {
		return json({ error: 'Invalid vote type for arguments. Must be support or reject.' }, { status: 400 });
	}

	// Gate: you must have positioned yourself on the parent thesis before voting
	// on its arguments. This keeps the opinion graph complete (every argument
	// voter has a known thesis stance).
	const argument = getArgumentById(params.id);
	if (!argument) {
		return json({ error: 'Argument not found' }, { status: 404 });
	}
	if (!hasUserVotedOnThesis(argument.thesis_id, user_id)) {
		return json(
			{ error: 'Position yourself on the thesis first — then you can weigh its arguments.', code: 'thesis_vote_required', thesis_id: argument.thesis_id },
			{ status: 403 }
		);
	}

	const w = normalizeVoteWeight(weight);
	// Base weight-1 votes are free; extra weight draws from the daily weight pool.
	const maturityErr = checkIdentityMaturityForWeight(cookies, w);
	if (maturityErr) return maturityErr;
	const budgetErr = checkWeightBudget(user_id, w);
	if (budgetErr) return budgetErr;

	const voted = voteOnArgument(params.id, user_id, type, w);

	if (!voted) {
		return json({ error: 'Argument not found' }, { status: 404 });
	}

	const voteSummary = computeVoteSummary(voted.votes);

	return json({ vote_summary: voteSummary, user_id, weight: w }, { status: 200 });
};