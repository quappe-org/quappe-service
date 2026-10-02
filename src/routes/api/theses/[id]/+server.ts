import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getThesisById, updateThesis, deleteThesis, computeVoteSummary, setThesisLang } from '$lib/stores/data';
import { checkLength, checkCategories } from '$lib/server/limits';
import { detectLanguage } from '$lib/server/language-detect';
import { checkRegisterDrift } from '$lib/server/register-drift';

export const GET: RequestHandler = async ({ params }) => {
	const thesis = getThesisById(params.id);

	if (!thesis) {
		return json({ error: 'Thesis not found' }, { status: 404 });
	}

	const voteSummary = computeVoteSummary(thesis.votes);

	return json({ ...thesis, vote_summary: voteSummary });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json();
	const { title, description, categories, description_simple, description_dense } = body;

	if (title !== undefined) {
		const err = checkLength('thesis_title', title);
		if (err) return err;
	}
	if (description !== undefined) {
		const err = checkLength('thesis_description', description);
		if (err) return err;
	}
	if (categories !== undefined) {
		const err = checkCategories(categories);
		if (err) return err;
	}
	// Register variants: validate length only when a non-empty value is present
	// (an empty string clears the variant).
	for (const val of [description_simple, description_dense]) {
		if (val !== undefined && val !== null && val !== '') {
			const err = checkLength('thesis_description', val);
			if (err) return err;
		}
	}

	// Drift-block: a register variant must stay close to the prose meaning. Use
	// the incoming description when the caller is also changing it, otherwise the
	// stored one, so the comparison is always against the current prose.
	const hasVariant = [description_simple, description_dense].some((v) => v !== undefined && v !== null && v !== '');
	if (hasVariant) {
		const existing = getThesisById(params.id);
		const prose = description ?? existing?.description ?? '';
		for (const val of [description_simple, description_dense]) {
			if (val !== undefined && val !== null && val !== '') {
				const drift = await checkRegisterDrift(prose, val);
				if (!drift.ok) {
					return json(
						{ error: 'Register variant drifted too far from the description', drift_score: drift.score },
						{ status: 422 }
					);
				}
			}
		}
	}

	const result = updateThesis(
		params.id,
		{ title, description, categories, description_simple, description_dense },
		locals.user_id
	);

	if ('error' in result) {
		return json({ error: result.error }, { status: 403 });
	}

	// Re-detect language when title or description changed.
	if (title !== undefined || description !== undefined) {
		detectLanguage(`${result.title} ${result.description}`)
			.then((lang) => setThesisLang(params.id, lang))
			.catch(() => {});
	}

	return json(result);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const existing = getThesisById(params.id);
	if (!existing) return json({ error: 'Thesis not found' }, { status: 404 });
	if (existing.meta.author_id !== locals.user_id) {
		return json({ error: 'Only the author can delete this thesis' }, { status: 403 });
	}

	const deleted = deleteThesis(params.id);
	if (!deleted) return json({ error: 'Thesis not found' }, { status: 404 });
	return json({ success: true }, { status: 200 });
};
