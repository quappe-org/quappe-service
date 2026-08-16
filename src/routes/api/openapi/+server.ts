// Serves the OpenAPI contract (openapi.yaml at the repo root) as raw YAML, so
// clients and tooling (Swagger UI, codegen) can fetch the spec at runtime:
//   GET /api/openapi
// YAML is the canonical format; consumers parse it as needed. Kept dependency-
// free (no server-side YAML parser) in line with the project's minimal footprint.

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let _cache: string | null = null;

export const GET: RequestHandler = () => {
	if (!_cache) {
		try {
			_cache = readFileSync(resolve('openapi.yaml'), 'utf-8');
		} catch {
			throw error(500, 'OpenAPI spec not found');
		}
	}
	return new Response(_cache, {
		headers: {
			'content-type': 'application/yaml; charset=utf-8',
			'cache-control': 'public, max-age=300'
		}
	});
};
