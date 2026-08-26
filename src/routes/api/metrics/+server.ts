import type { RequestHandler } from '@sveltejs/kit';
import { renderMetrics } from '$lib/server/metrics';

export const GET: RequestHandler = () => {
	return new Response(renderMetrics(), {
		headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }
	});
};
