import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getThesisById,
	getThesisEdgesForTarget,
	getThesisEdgeBySourceTarget,
	createThesisEdge,
	hasUserVotedOnThesis
} from '$lib/stores/data';
import { checkRate, getClientIp } from '$lib/server/limits';

// GET — theses linked "as an argument" onto :id, hydrated with each source thesis.
export const GET: RequestHandler = async ({ params }) => {
	const target = getThesisById(params.id);
	if (!target) return json({ error: 'Thesis not found' }, { status: 404 });

	const edges = getThesisEdgesForTarget(params.id);
	return json({ edges });
};

// POST — link a thesis (source_thesis_id) onto :id as an argument. The edge is
// stanceless: the pro/con/neutral meaning comes from the author's own vote on
// :id, enforced by the same vote-first gate that native arguments use.
export const POST: RequestHandler = async ({ request, params, getClientAddress, locals }) => {
	const body = await request.json();
	const { source_thesis_id }: { source_thesis_id: string } = body;

	const ip = getClientIp(request, getClientAddress());
	const rate = checkRate(ip, locals.user_id, 'write_light');
	if (rate) return rate;

	const target_id = params.id;

	if (!source_thesis_id) {
		return json({ error: 'Missing required field: source_thesis_id' }, { status: 400 });
	}
	if (source_thesis_id === target_id) {
		return json(
			{ error: 'A thesis cannot be linked to itself.', code: 'self_link' },
			{ status: 400 }
		);
	}

	if (!getThesisById(target_id)) {
		return json({ error: 'Thesis not found' }, { status: 404 });
	}
	if (!getThesisById(source_thesis_id)) {
		return json(
			{ error: 'Source thesis not found.', code: 'source_missing' },
			{ status: 400 }
		);
	}

	// Gate: you must have positioned yourself on the target thesis before linking
	// another thesis onto it — same rule as adding an argument, so the opinion
	// graph stays complete (every contributor has a known thesis stance).
	if (!hasUserVotedOnThesis(target_id, locals.user_id)) {
		return json(
			{
				error: 'Position yourself on the thesis first — then you can link a thesis as an argument.',
				code: 'thesis_vote_required',
				thesis_id: target_id
			},
			{ status: 403 }
		);
	}

	if (getThesisEdgeBySourceTarget(source_thesis_id, target_id)) {
		return json(
			{ error: 'This thesis is already linked here.', code: 'edge_exists' },
			{ status: 409 }
		);
	}

	// author_id comes from the verified identity — the request body is never trusted.
	const edge = createThesisEdge(source_thesis_id, target_id, locals.user_id);
	return json(edge, { status: 201 });
};
