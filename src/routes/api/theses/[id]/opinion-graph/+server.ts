import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dbArgumentApprovalByThesisStance } from '$lib/server/db/votes';

// Opinion graph for a thesis: for each argument, how its approvers split by
// their own thesis position. This is the emergent replacement for author-
// declared stance — meaning is derived from who agrees with what.
export const GET: RequestHandler = async ({ params }) => {
	const approvals = dbArgumentApprovalByThesisStance(params.id);
	return json({ thesis_id: params.id, arguments: approvals });
};
