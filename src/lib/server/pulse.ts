// Community-Puls-Report — shared state so both the API endpoint and the
// startup/daily background job in hooks.server.ts can populate the same cache.

import {
	getAllTheses,
	getArgumentCounts,
	getHeatMap,
	computeVoteSummary,
	seedData
} from '$lib/stores/data';
import { generate } from './llm';
import { baseLocale, type Locale } from '$lib/paraglide/runtime';
import { FIB_ARGUMENTS } from '$lib/models/fibonacci';

const PULSE_TTL_MS = 24 * 60 * 60 * 1000;

// Register steps mirror FIB_ARGUMENTS notches (0 = terse … last = full).
const REGISTER_STEPS = FIB_ARGUMENTS.length; // 5

interface CachedPulse {
	generated_at: number;
	body: PulseBody;
}
// Keyed by `${locale}::${step}` so each register variant caches independently.
const _cached = new Map<string, CachedPulse>();

function pulseKey(locale: Locale, step: number): string {
	return `${locale}::${step}`;
}

// Per-locale density directives, one per register step. Appended to the pulse
// prompt so the reader's amount slider drives text length. The server owns this
// mapping — the client only forwards the raw slider value.
const DENSITY: Record<Locale, string[]> = {
	en: [
		'Write ONE sentence only. Telegraphic.',
		'Write 2 short sentences.',
		'Write 3 short paragraphs, 1 sentence each.',
		'Write 3 paragraphs, 1-2 sentences each.',
		'Write 3 full paragraphs, up to ~100 words total.'
	],
	de: [
		'Schreibe NUR einen Satz. Telegrammstil.',
		'Schreibe 2 kurze Sätze.',
		'Schreibe 3 kurze Absätze, je 1 Satz.',
		'Schreibe 3 Absätze, je 1-2 Sätze.',
		'Schreibe 3 volle Absätze, insgesamt bis ca. 100 Wörter.'
	],
	fr: [
		'Écris UNE seule phrase. Style télégraphique.',
		'Écris 2 phrases courtes.',
		'Écris 3 courts paragraphes, 1 phrase chacun.',
		'Écris 3 paragraphes, 1 à 2 phrases chacun.',
		'Écris 3 paragraphes complets, jusqu’à ~100 mots au total.'
	],
	es: [
		'Escribe UNA sola frase. Estilo telegráfico.',
		'Escribe 2 frases cortas.',
		'Escribe 3 párrafos cortos, 1 frase cada uno.',
		'Escribe 3 párrafos, 1 o 2 frases cada uno.',
		'Escribe 3 párrafos completos, hasta ~100 palabras en total.'
	]
};

interface CategoryPulse {
	name: string;
	thesis_count: number;
	argument_count: number;
	avg_support_ratio: number;
}

export interface PulseStats {
	total_theses: number;
	total_arguments: number;
	hot_theses: { id: string; title: string; heat: number; arguments: number }[];
	complex_theses: { id: string; title: string; arguments: number }[];
	driving_categories: CategoryPulse[];
	recent_week: { new_theses: number; new_arguments: number };
}

export interface PulseBody {
	text: string | null;
	stats: PulseStats;
	generated_at: string;
	llm: { ok: boolean; model?: string | null; duration_ms?: number; error?: string; hint?: string };
}

function aggregate(): PulseStats {
	seedData();
	const theses = getAllTheses();
	const argCounts = getArgumentCounts();
	const heat = getHeatMap();
	const NOW = Date.now();
	const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

	let total_arguments = 0;
	for (const n of argCounts.values()) total_arguments += n;

	let new_theses = 0;
	for (const t of theses) {
		if (NOW - new Date(t.meta.created_at).getTime() < WEEK_MS) new_theses++;
	}

	const hot_theses = [...theses]
		.map((t) => ({
			id: t.id,
			title: t.title,
			heat: heat.get(t.id) ?? 0,
			arguments: argCounts.get(t.id) ?? 0
		}))
		.filter((t) => t.heat > 0 || t.arguments > 0)
		.sort((a, b) => b.heat - a.heat)
		.slice(0, 5);

	const complex_theses = [...theses]
		.map((t) => {
			const summary = computeVoteSummary(t.votes);
			const total = summary.total || 1;
			const balance = 1 - Math.abs(summary.support - summary.reject) / total;
			const args = argCounts.get(t.id) ?? 0;
			return { id: t.id, title: t.title, arguments: args, balance };
		})
		.filter((t) => t.arguments >= 2 && t.balance > 0.4)
		.sort((a, b) => b.balance * b.arguments - a.balance * a.arguments)
		.slice(0, 5)
		.map(({ balance, ...rest }) => rest);

	const catStats = new Map<string, { theses: number; args: number; support: number; total: number }>();
	for (const t of theses) {
		const summary = computeVoteSummary(t.votes);
		const args = argCounts.get(t.id) ?? 0;
		for (const c of t.categories) {
			const s = catStats.get(c) ?? { theses: 0, args: 0, support: 0, total: 0 };
			s.theses += 1;
			s.args += args;
			s.support += summary.support;
			s.total += summary.total;
			catStats.set(c, s);
		}
	}
	const driving_categories: CategoryPulse[] = [...catStats.entries()]
		.map(([name, s]) => ({
			name,
			thesis_count: s.theses,
			argument_count: s.args,
			avg_support_ratio: s.total > 0 ? s.support / s.total : 0
		}))
		.sort((a, b) => b.argument_count - a.argument_count)
		.slice(0, 5);

	return {
		total_theses: theses.length,
		total_arguments,
		hot_theses,
		complex_theses,
		driving_categories,
		recent_week: { new_theses, new_arguments: 0 }
	};
}

interface PulseCopy {
	system: string;
	empty: string;
	buildPrompt: (stats: PulseStats, step: number) => string;
}

const PULSE_COPY: Record<Locale, PulseCopy> = {
	en: {
		system:
			'You observe an English-language debate platform. Short, crisp sentences. Descriptive, not judgmental. No emojis, no numbers, no bullet lists.',
		empty: 'Nothing happening in the community yet.',
		buildPrompt(stats, step) {
			const hotList = stats.hot_theses.map((t, i) => `${i + 1}. "${t.title}"`).join('\n') || '—';
			const complexList = stats.complex_theses.map((t, i) => `${i + 1}. "${t.title}"`).join('\n') || '—';
			const catList = stats.driving_categories.map((c) => c.name).join(', ') || '—';
			return `Write an English-language "community pulse" for a debate platform. Short, crisp sentences. Observing, not judging.

Hotly discussed:
${hotList}

Complex (contested, many arguments):
${complexList}

Categories with most activity: ${catList}

Cover: (1) what's hot right now — the common thread in content, (2) where it gets complex — which thesis/theses show real contention, (3) a look ahead — an under-represented area.

Do not repeat any numbers (they are shown alongside). No headings.
${DENSITY.en[step]}`;
		}
	},
	de: {
		system:
			'Du beobachtest eine deutschsprachige Debatten-Plattform. Kurze, knackige Sätze. Beschreibend, nicht wertend. Keine Emojis, keine Zahlen, keine Aufzählungen.',
		empty: 'Noch nichts los in der Community.',
		buildPrompt(stats, step) {
			const hotList = stats.hot_theses.map((t, i) => `${i + 1}. "${t.title}"`).join('\n') || '—';
			const complexList = stats.complex_theses.map((t, i) => `${i + 1}. "${t.title}"`).join('\n') || '—';
			const catList = stats.driving_categories.map((c) => c.name).join(', ') || '—';
			return `Fasse einen deutschsprachigen "Community-Puls" für eine Debatten-Plattform. Kurze, knackige Sätze. Beobachtend, nicht wertend.

Heiß diskutiert:
${hotList}

Komplex (kontrovers, viele Argumente):
${complexList}

Kategorien mit meiste Aktivität: ${catList}

Behandle: (1) Was gerade heiß ist — inhaltlicher Nenner, (2) wo es komplex wird — welche These(n) zeigen echte Kontroverse, (3) Blick nach vorn — ein unterrepräsentiertes Feld.

Keine Zahlen wiederholen (die stehen daneben). Keine Überschriften.
${DENSITY.de[step]}`;
		}
	},
	fr: {
		system:
			"Tu observes une plateforme de débat francophone. Phrases courtes et nettes. Descriptif, pas de jugement. Pas d'emojis, pas de chiffres, pas de listes à puces.",
		empty: 'Rien ne bouge encore dans la communauté.',
		buildPrompt(stats, step) {
			const hotList = stats.hot_theses.map((t, i) => `${i + 1}. « ${t.title} »`).join('\n') || '—';
			const complexList = stats.complex_theses.map((t, i) => `${i + 1}. « ${t.title} »`).join('\n') || '—';
			const catList = stats.driving_categories.map((c) => c.name).join(', ') || '—';
			return `Rédige un « pouls communautaire » en français pour une plateforme de débat. Phrases courtes et nettes. Observation, pas de jugement.

Vivement débattues :
${hotList}

Complexes (contestées, beaucoup d'arguments) :
${complexList}

Catégories les plus actives : ${catList}

Aborde : (1) ce qui est chaud en ce moment — le fil conducteur des contenus, (2) où cela se complique — quelle(s) thèse(s) montrent une vraie contestation, (3) un regard vers l'avant — un domaine sous-représenté.

Ne répète aucun chiffre (ils sont affichés à côté). Pas de titres.
${DENSITY.fr[step]}`;
		}
	},
	es: {
		system:
			'Observas una plataforma de debate en español. Frases cortas y nítidas. Descriptivo, no valorativo. Sin emojis, sin cifras, sin listas.',
		empty: 'Aún no hay movimiento en la comunidad.',
		buildPrompt(stats, step) {
			const hotList = stats.hot_theses.map((t, i) => `${i + 1}. «${t.title}»`).join('\n') || '—';
			const complexList = stats.complex_theses.map((t, i) => `${i + 1}. «${t.title}»`).join('\n') || '—';
			const catList = stats.driving_categories.map((c) => c.name).join(', ') || '—';
			return `Redacta un «pulso de la comunidad» en español para una plataforma de debate. Frases cortas y nítidas. Observando, sin juzgar.

Muy debatidas:
${hotList}

Complejas (disputadas, muchos argumentos):
${complexList}

Categorías con más actividad: ${catList}

Aborda: (1) qué está caliente ahora — el hilo común del contenido, (2) dónde se vuelve complejo — qué tesis muestran verdadera disputa, (3) una mirada hacia adelante — un área infrarrepresentada.

No repitas ninguna cifra (se muestran al lado). Sin encabezados.
${DENSITY.es[step]}`;
		}
	}
};

export async function generatePulse(
	locale: Locale = baseLocale,
	step: number = REGISTER_STEPS - 1
): Promise<PulseBody> {
	const stats = aggregate();
	return generatePulseFromStats(stats, locale, step);
}

// Generate one register variant from already-aggregated stats. Split out so the
// batch job can aggregate once and generate all 5 variants without re-scanning.
async function generatePulseFromStats(
	stats: PulseStats,
	locale: Locale,
	step: number
): Promise<PulseBody> {
	const copy = PULSE_COPY[locale] ?? PULSE_COPY[baseLocale];

	if (stats.total_theses === 0) {
		return {
			text: copy.empty,
			stats,
			generated_at: new Date().toISOString(),
			llm: { ok: true, model: null, duration_ms: 0 }
		};
	}

	const prompt = copy.buildPrompt(stats, step);
	const result = await generate(prompt, {
		system: copy.system,
		maxTokens: 300
	});

	return {
		text: result.ok ? result.text : null,
		stats,
		generated_at: new Date().toISOString(),
		llm: result.ok
			? { ok: true, model: result.model, duration_ms: result.duration_ms }
			: { ok: false, error: result.error, hint: result.hint }
	};
}

export function getCachedPulse(
	locale: Locale = baseLocale,
	step: number = REGISTER_STEPS - 1
): { body: PulseBody; generated_at: number } | null {
	const hit = _cached.get(pulseKey(locale, step));
	if (!hit) return null;
	if (Date.now() - hit.generated_at > PULSE_TTL_MS) return null;
	return hit;
}

export async function refreshPulseCache(
	locale: Locale = baseLocale,
	step: number = REGISTER_STEPS - 1
): Promise<PulseBody> {
	const body = await generatePulse(locale, step);
	_cached.set(pulseKey(locale, step), { generated_at: Date.now(), body });
	return body;
}

// Batch pre-compute all register variants for a locale. Aggregates once, then
// generates one text per FIB_ARGUMENTS notch — this is what the daily background
// job calls so every slider position serves warm from cache.
export async function refreshAllPulseVariants(locale: Locale = baseLocale): Promise<void> {
	const stats = aggregate();
	for (let step = 0; step < REGISTER_STEPS; step++) {
		const body = await generatePulseFromStats(stats, locale, step);
		_cached.set(pulseKey(locale, step), { generated_at: Date.now(), body });
	}
}
