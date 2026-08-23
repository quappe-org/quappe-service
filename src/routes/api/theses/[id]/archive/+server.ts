import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { archiveThesis } from '$lib/stores/data';
import { requireAdmin } from '$lib/server/admin-auth';

export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const denied = requireAdmin(request, cookies);
	if (denied) return denied;

	const body = await request.json().catch(() => ({}));
	const archived = body.archived !== false; // default: archive
	const updated = archiveThesis(params.id, archived);
	if (!updated) return json({ error: 'Thesis not found' }, { status: 404 });
	return json(updated);
};
