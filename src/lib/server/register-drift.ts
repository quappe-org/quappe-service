// Register-drift guard — keeps an author-owned reading register (simple/dense)
// from wandering away from the prose original's *meaning*. The registers are
// author-owned, but "author-owned" means responsible for wording, not licence
// to say something different. We embed the prose and the variant and compare
// them; too far apart and the write is rejected (422) so a divergent rephrase
// never gets persisted.
//
// Threshold is instance-config (QUAPPE_REGISTER_DRIFT_MIN, default 0.82 =
// medium). Cosine similarity of the multilingual-e5 embeddings; two faithful
// rephrasings of the same claim sit well above 0.82, an off-topic swap drops
// below it.

import { embed, isModelWarm } from './embeddings';
import { cosineSimilarity } from './similarity';
import { logger } from '$lib/stores/logger';

const DEFAULT_DRIFT_MIN = 0.82;

/**
 * Minimum cosine similarity a register variant must keep with its prose
 * original. Configurable per instance via QUAPPE_REGISTER_DRIFT_MIN; falls back
 * to 0.82 (medium) when unset or unparseable.
 */
export function driftThreshold(): number {
	const raw = process.env.QUAPPE_REGISTER_DRIFT_MIN;
	if (raw === undefined || raw === '') return DEFAULT_DRIFT_MIN;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_DRIFT_MIN;
}

export interface DriftResult {
	score: number;
	ok: boolean;
	threshold: number;
}

/**
 * Embed prose + variant and compare. `ok` is true when the variant stays at or
 * above the configured threshold. Infra failures (model not warm, embed throws)
 * return `ok:true` — we never block a write on our own embedding availability.
 */
export async function checkRegisterDrift(prose: string, variant: string): Promise<DriftResult> {
	const threshold = driftThreshold();
	if (!isModelWarm()) {
		return { score: 1, ok: true, threshold };
	}
	try {
		const [a, b] = await Promise.all([embed(prose, 'passage'), embed(variant, 'passage')]);
		const score = cosineSimilarity(a, b);
		const ok = score >= threshold;
		if (!ok) {
			logger.info('similarity', 'register variant drifted', { score: score.toFixed(3), threshold });
		}
		return { score, ok, threshold };
	} catch (err) {
		logger.warn('similarity', 'register drift check failed — allowing write', {
			error: (err as Error)?.message
		});
		return { score: 1, ok: true, threshold };
	}
}
