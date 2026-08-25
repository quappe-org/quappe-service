import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

// Enumerate all API routes in the source tree by walking src/routes/api/**/+server.ts.
// Convert each path to the OpenAPI style ("[id]" → "{id}") for direct comparison.
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p));
		else if (entry === '+server.ts') out.push(p);
	}
	return out;
}

function fileToApiPath(file: string): string {
	// e.g. src/routes/api/theses/[id]/vote/+server.ts → /api/theses/{id}/vote
	const rel = file.split(`${sep}routes${sep}`)[1].replace(`${sep}+server.ts`, '');
	return (
		'/' +
		rel
			.split(sep)
			.map((seg) => seg.replace(/^\[(.+)]$/, '{$1}'))
			.join('/')
	);
}

// Extract exported HTTP methods from the file: `export const GET`, `export const POST`, ...
function methodsIn(file: string): string[] {
	const src = readFileSync(file, 'utf-8');
	const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
	return methods.filter((m) => new RegExp(`export\\s+const\\s+${m}\\b`).test(src));
}

// Minimal YAML slice for our contract check: find every top-level `paths:` key
// entry (unindented `  /api/…:` lines) plus the HTTP methods listed under it.
// Full YAML parsing would need a dep — this project keeps the dep footprint tiny.
function specPaths(): Map<string, Set<string>> {
	const yaml = readFileSync(join(process.cwd(), 'openapi.yaml'), 'utf-8');
	const lines = yaml.split('\n');
	const map = new Map<string, Set<string>>();
	let inPaths = false;
	let current: string | null = null;
	for (const line of lines) {
		if (/^paths:\s*$/.test(line)) {
			inPaths = true;
			continue;
		}
		if (inPaths && /^\S/.test(line)) {
			inPaths = false; // hit next top-level key
			current = null;
			continue;
		}
		if (!inPaths) continue;
		const pathMatch = line.match(/^ {2}(\/api\/[^\s:]+):\s*$/);
		if (pathMatch) {
			current = pathMatch[1];
			map.set(current, new Set());
			continue;
		}
		if (current) {
			const methodMatch = line.match(/^ {4}(get|post|put|delete|patch):/);
			if (methodMatch) {
				map.get(current)!.add(methodMatch[1].toUpperCase());
			}
		}
	}
	return map;
}

describe('OpenAPI contract: openapi.yaml matches the actual routes', () => {
	const routeFiles = walk(join(process.cwd(), 'src', 'routes', 'api'));
	const actual = new Map<string, Set<string>>();
	for (const f of routeFiles) {
		actual.set(fileToApiPath(f), new Set(methodsIn(f)));
	}
	const spec = specPaths();

	it('every implemented route is documented in openapi.yaml', () => {
		const missing: string[] = [];
		for (const [path, methods] of actual) {
			const specMethods = spec.get(path);
			if (!specMethods) {
				missing.push(`${path} [${[...methods].join(',')}] — path not in spec`);
				continue;
			}
			for (const m of methods) {
				if (!specMethods.has(m)) missing.push(`${path} ${m} — method not documented`);
			}
		}
		expect(missing, `Undocumented endpoints:\n  ${missing.join('\n  ')}`).toEqual([]);
	});

	it('every documented path in openapi.yaml exists in the source tree', () => {
		const stale: string[] = [];
		for (const [path] of spec) {
			if (!actual.has(path)) stale.push(`${path} — documented but no handler found`);
		}
		expect(stale, `Stale paths in openapi.yaml:\n  ${stale.join('\n  ')}`).toEqual([]);
	});

	it('openapi.yaml version matches package.json', () => {
		const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
		const yaml = readFileSync(join(process.cwd(), 'openapi.yaml'), 'utf-8');
		const versionMatch = yaml.match(/^\s*version:\s*(\S+)\s*$/m);
		expect(versionMatch, 'openapi.yaml has no `version:` in info block').toBeTruthy();
		expect(versionMatch![1]).toBe(pkg.version);
	});
});
