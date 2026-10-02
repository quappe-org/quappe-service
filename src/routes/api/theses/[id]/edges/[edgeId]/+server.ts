import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getThesisEdgeById, deleteThesisEdge } from '$lib/stores/data';

// DELETE — unlink a thesis-as-argument edge. Only its author may remove it.
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const edge = getThesisEdgeById(params.edgeId);
	if (!edge || edge.target_thesis_id !== params.id) {
		return json({ error: 'Edge not found' }, { status: 404 });
	}
	if (edge.author_id !== locals.user_id) {
		return json(
			{ error: 'Only the author can remove this link.', code: 'not_edge_author' },
			{ status: 403 }
		);
	}
	deleteThesisEdge(edge.id);
	return json({ ok: true });
};
