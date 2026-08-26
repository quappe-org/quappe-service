// Handrolled Prometheus text-format emitter. No prom-client dependency.
// All state is module-scoped; this module is a singleton in the Node process.
//
// Supported metric types:
//   counter   — monotonically increasing, exported as _total
//   histogram — exponential buckets for duration measurements
//   gauge     — point-in-time value (set via a callback at scrape time)

import { statSync } from 'fs';
import { resolve } from 'path';

// ---- Counter ----

interface Counter {
	type: 'counter';
	help: string;
	values: Map<string, number>; // label-string → value
}

// ---- Histogram ----

// Fixed exponential buckets for duration in seconds: .005 .01 .025 .05 .1 .25 .5 1 2.5 5 10
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram {
	type: 'histogram';
	help: string;
	buckets: number[];
	counts: number[]; // per bucket (cumulative)
	sum: number;
	total: number;
}

// ---- Gauge ----

interface Gauge {
	type: 'gauge';
	help: string;
	collect: () => number; // callback — called at scrape time
}

type Metric = Counter | Histogram | Gauge;

const registry = new Map<string, Metric>();

function getOrCreate<T extends Metric>(name: string, factory: () => T): T {
	let m = registry.get(name);
	if (!m) {
		m = factory();
		registry.set(name, m);
	}
	return m as T;
}

// ---- Public API ----

/** Increment a counter by 1. Labels are passed as key=value pairs in alphabetical order. */
export function incCounter(name: string, help: string, labels: Record<string, string> = {}): void {
	const m = getOrCreate<Counter>(name, () => ({ type: 'counter', help, values: new Map() }));
	const key = serializeLabels(labels);
	m.values.set(key, (m.values.get(key) ?? 0) + 1);
}

/** Record a duration observation (in seconds) to a histogram. */
export function observeHistogram(name: string, help: string, seconds: number): void {
	const m = getOrCreate<Histogram>(name, () => ({
		type: 'histogram',
		help,
		buckets: DURATION_BUCKETS,
		counts: new Array(DURATION_BUCKETS.length).fill(0),
		sum: 0,
		total: 0
	}));
	for (let i = 0; i < m.buckets.length; i++) {
		if (seconds <= m.buckets[i]) m.counts[i]++;
	}
	m.sum += seconds;
	m.total++;
}

/** Register a gauge with a live-read callback. Call once at startup. */
export function registerGauge(name: string, help: string, collect: () => number): void {
	if (!registry.has(name)) {
		registry.set(name, { type: 'gauge', help, collect });
	}
}

// ---- Pre-registered metrics ----

// DB size gauge — reads the file stat at scrape time.
const DB_PATH = process.env.QUAPPE_DB_PATH ?? resolve(process.cwd(), '.data/quappe.db');
registerGauge('quappe_db_size_bytes', 'SQLite database file size in bytes', () => {
	try { return statSync(DB_PATH).size; } catch { return 0; }
});

// ---- Scrape / render ----

function serializeLabels(labels: Record<string, string>): string {
	const keys = Object.keys(labels).sort();
	if (keys.length === 0) return '';
	return '{' + keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',') + '}';
}

function escapeLabelValue(v: string): string {
	return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Render all registered metrics in Prometheus text exposition format. */
export function renderMetrics(): string {
	const lines: string[] = [];
	for (const [name, m] of registry) {
		lines.push(`# HELP ${name} ${m.help}`);
		if (m.type === 'counter') {
			lines.push(`# TYPE ${name} counter`);
			for (const [labelStr, value] of m.values) {
				lines.push(`${name}_total${labelStr} ${value}`);
			}
		} else if (m.type === 'histogram') {
			lines.push(`# TYPE ${name} histogram`);
			for (let i = 0; i < m.buckets.length; i++) {
				lines.push(`${name}_bucket{le="${m.buckets[i]}"} ${m.counts[i]}`);
			}
			lines.push(`${name}_bucket{le="+Inf"} ${m.total}`);
			lines.push(`${name}_sum ${m.sum}`);
			lines.push(`${name}_count ${m.total}`);
		} else if (m.type === 'gauge') {
			lines.push(`# TYPE ${name} gauge`);
			lines.push(`${name} ${m.collect()}`);
		}
	}
	lines.push('');
	return lines.join('\n');
}
