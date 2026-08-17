// Nightly LLM batch: assign categories to arguments that don't yet have any.
//
// Human authors don't pick argument categories at write time (they picked one
// for the parent thesis, and forcing them again is friction). Instead we run
// this idempotent job daily: enumerate all arguments whose `categories` field
// is undefined, ask the local LLM to pick 1–2 topics from DEFAULT_CATEGORIES,
// and write them back via setArgumentCategories.
//
// Conservative approach: we only label an argument when the LLM gives a clear,
// confident answer. Ambiguous or uncertain cases stay unlabelled (undefined)
// and will be retried on the next run. Less noise > more labels.

import { getAllArguments, setArgumentCategories } from '$lib/stores/data';
import { DEFAULT_CATEGORIES } from '$lib/models/types';
import { generate, isLlmAvailable } from './llm';
import { logger } from '$lib/stores/logger';

/** Minimum argument length (chars) to attempt categorization. Short fragments
 *  ("I agree", "exactly!") rarely carry enough signal for a meaningful label. */
const MIN_CONTENT_LENGTH = 40;

const CAT_LIST = DEFAULT_CATEGORIES.filter((c) => c !== 'other').join(', ');

function buildPrompt(content: string): string {
	return `You classify short debate arguments by topic.

Argument:
"""${content}"""

Pick exactly 1 topical category from this fixed list:
${CAT_LIST}

Rules:
- Answer with a SINGLE category name, nothing else.
- Only pick a category if the argument CLEARLY belongs to it.
- If the argument is too vague, too short, or does not clearly fit any category, answer exactly: SKIP
- Do NOT guess. When in doubt, answer: SKIP`;
}

function parseCategory(raw: string): string | null {
	const known = new Set<string>(DEFAULT_CATEGORIES.map((c) => c.toLowerCase()));
	const trimmed = raw.trim().toLowerCase();

	// Explicit skip signal — LLM is uncertain
	if (trimmed === 'skip' || trimmed.includes('skip')) return null;

	// "other" is not a useful label — treat as uncertain
	if (trimmed === 'other') return null;

	// Try to extract a single known category
	const tokens = trimmed
		.split(/[^a-zA-Z]+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && known.has(t) && t !== 'other');

	// Only accept if we got exactly one clear category (no ambiguity)
	if (tokens.length === 1) return tokens[0];

	// Multiple categories returned = uncertain, skip
	return null;
}

/**
 * Categorise all arguments whose `categories` field is unset.
 * Returns the number of arguments successfully annotated.
 * Never throws — uncertain results leave the argument unlabelled for retry.
 */
export async function categorizeUncategorizedArguments(): Promise<number> {
	const allTargets = getAllArguments().filter((a) => a.categories === undefined);
	// Skip very short arguments — not enough signal for meaningful categorization.
	const targets = allTargets.filter((a) => a.content.length >= MIN_CONTENT_LENGTH);
	const skippedShort = allTargets.length - targets.length;

	if (targets.length === 0) {
		logger.info('system', `argument categorizer: nothing to do (${skippedShort} too short)`);
		return 0;
	}

	const llmUp = await isLlmAvailable();
	if (!llmUp) {
		// LLM down — leave arguments unlabelled. They'll be retried next run.
		// No forced 'other' labels; prefer silence over noise.
		logger.warn('system', `argument categorizer: LLM unavailable, skipping ${targets.length} args`);
		return 0;
	}

	logger.info('system', `argument categorizer: processing ${targets.length} arguments (${skippedShort} skipped as too short)`);
	let labelled = 0;
	let uncertain = 0;
	for (const arg of targets) {
		const result = await generate(buildPrompt(arg.content), {
			system: 'You are a strict classifier. Output only a single category name from the given list, or SKIP if uncertain. No prose.',
			maxTokens: 10,
			temperature: 0.0
		});

		if (!result.ok) {
			uncertain++;
			continue; // leave unlabelled, retry next run
		}

		const cat = parseCategory(result.text);
		if (cat) {
			setArgumentCategories(arg.id, [cat]);
			labelled++;
		} else {
			uncertain++;
			// Leave unlabelled — will be retried. If the LLM is consistently
			// uncertain about this argument, it stays without a category. That's fine.
		}

		if ((labelled + uncertain) % 25 === 0) {
			logger.info('system', `argument categorizer: ${labelled} labelled, ${uncertain} uncertain / ${targets.length}`);
		}
		// Yield so request handling doesn't starve during a long batch.
		await new Promise((r) => setImmediate(r));
	}
	logger.info('system', `argument categorizer: done — ${labelled} labelled, ${uncertain} uncertain, ${skippedShort} too short`);
	return labelled;
}
