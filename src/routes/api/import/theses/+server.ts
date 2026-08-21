import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { importThesis, listImportedTheses, purgeImportedTheses, type ImportThesisInput } from '$lib/stores/data';
import { DEFAULT_CATEGORIES } from '$lib/models/types';

// Bulk import endpoint for issue-tracker bridges. Not part of the user flow:
// guarded by a shared secret (QUAPPE_IMPORT_SECRET), bypasses budget/rate
// limits, and upserts by external_ref for idempotent re-sync.
//
//   POST   /api/import/theses      body: { theses: ImportItem[] }
//   GET    /api/import/theses?source=github:owner/repo   → existing refs
//   DELETE /api/import/theses?source=github:owner/repo   → purge that source

const IMPORT_AUTHOR = 'system:bridge';

interface ImportItem {
	external_ref: string;
	title: string;
	description: string;
	categories?: string[];
	hashtags?: string[];
	archived?: boolean;
}

function authorized(request: Request): boolean {
	const secret = process.env.QUAPPE_IMPORT_SECRET;
	if (!secret) return false; // import disabled unless a secret is configured
	return request.headers.get('x-import-secret') === secret;
}

// Keep only categories the platform knows; fall back to 'other' if none match.
function normalizeCategories(cats: string[] | undefined): string[] {
	const allowed = new Set(DEFAULT_CATEGORIES.map((c) => c.toLowerCase()));
	const out: string[] = [];
	for (const c of cats ?? []) {
		const lc = String(c).trim().toLowerCase();
		if (lc && allowed.has(lc) && !out.includes(lc)) out.push(lc);
	}
	return out.length > 0 ? out : ['other'];
}

export const POST: RequestHandler = async ({ request }) => {
	if (!authorized(request)) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const items: ImportItem[] = Array.isArray(body?.theses) ? body.theses : [];
	if (items.length === 0) return json({ error: 'No theses provided' }, { status: 400 });

	let created = 0;
	let updated = 0;
	const results: { external_ref: string; id: string; created: boolean }[] = [];

	for (const item of items) {
		if (!item.external_ref || !item.title || !item.description) continue;
		const input: ImportThesisInput = {
			external_ref: item.external_ref,
			title: item.title.slice(0, 200),
			description: item.description.slice(0, 2000),
			categories: normalizeCategories(item.categories),
			hashtags: item.hashtags,
			archived: item.archived ?? false,
			author_id: IMPORT_AUTHOR
		};
		const { thesis, created: wasCreated } = importThesis(input);
		if (wasCreated) created++;
		else updated++;
		results.push({ external_ref: item.external_ref, id: thesis.id, created: wasCreated });
	}

	return json({ ok: true, created, updated, total: results.length, results }, { status: 200 });
};

export const GET: RequestHandler = async ({ request, url }) => {
	if (!authorized(request)) return json({ error: 'Unauthorized' }, { status: 401 });
	const source = url.searchParams.get('source');
	if (!source) return json({ error: 'Missing ?source=' }, { status: 400 });
	const theses = listImportedTheses(source);
	return json({
		source,
		count: theses.length,
		refs: theses.map((t) => ({ external_ref: t.external_ref, id: t.id, title: t.title }))
	});
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	if (!authorized(request)) return json({ error: 'Unauthorized' }, { status: 401 });
	const source = url.searchParams.get('source');
	if (!source) return json({ error: 'Missing ?source=' }, { status: 400 });
	const ids = purgeImportedTheses(source);
	return json({ ok: true, source, purged: ids.length });
};
