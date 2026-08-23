import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getThesesWithEmbeddings, seedData } from '$lib/stores/data';
import { embed } from '$lib/server/embeddings';
import { findSimilarTheses } from '$lib/server/similarity';
import { LIMITS, checkRate, getClientIp } from '$lib/server/limits';

// Strict "is there a near-duplicate?" check for the thesis-creation flow.
// Unlike /api/search (which broadens with a fulltext fallback so users FIND
// things), this returns ONLY theses that are genuinely close in meaning — a
// high cosine bar, no fulltext padding. Empty result = "yours looks new",
// which is the common and correct case. We'd rather miss a loose match than
// nag the author with absurd "alternatives".
const NEAR_DUPLICATE_THRESHOLD = 0.78;

export const GET: RequestHandler = async ({ url, request, getClientAddress }) => {
	seedData();

	const ip = getClientIp(request, getClientAddress());
	const rate = checkRate(ip, null, 'read');
	if (rate) return rate;

	const raw = url.searchParams.get('q')?.trim() ?? '';
	if (raw.length < 8) return json({ results: [] });
	const q = raw.length > LIMITS.search_query ? raw.slice(0, LIMITS.search_query) : raw;

	const candidates = getThesesWithEmbeddings();
	if (candidates.length < 1) return json({ results: [] });

	try {
		const queryVec = await embed(q, 'query');
		const similar = findSimilarTheses(queryVec, candidates, 3, undefined, NEAR_DUPLICATE_THRESHOLD);
		return json({ results: similar.map((s) => ({ ...s.thesis, _score: s.score })) });
	} catch {
		// Embedding unavailable — don't block creation, just show nothing.
		return json({ results: [] });
	}
};
