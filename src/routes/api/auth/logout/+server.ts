import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setRole } from '$lib/server/identity';

// Drop any elevated role — keeps the same anonymous identity, clears role.
export const POST: RequestHandler = async ({ cookies }) => {
	setRole(cookies, undefined);
	return json({ ok: true });
};
