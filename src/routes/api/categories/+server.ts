import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDistinctCategories } from '$lib/stores/data';

// Public read. Returns the distinct categories actually present across theses,
// so clients (the feed filter) show what exists — imported repo names plus any
// domain topics — rather than a fixed whitelist. Empty DB → []; the client
// falls back to its default topic list for the create form.
export const GET: RequestHandler = async () => {
	return json({ categories: getDistinctCategories() });
};
