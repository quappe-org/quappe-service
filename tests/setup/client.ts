/**
 * Minimal API client that persists cookies across requests. One instance per
 * simulated user — each client's `quappe_uid` cookie is minted independently
 * by the server on the first request, giving each client its own identity.
 */
export interface ApiClient {
	get: (path: string, headers?: Record<string, string>) => Promise<Response>;
	post: (path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
	put: (path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
	del: (path: string, headers?: Record<string, string>) => Promise<Response>;
	cookies: () => string;
	loginAs: (role: 'member' | 'admin', secrets: { member: string; admin: string }) => Promise<void>;
}

export function apiClient(baseURL: string): ApiClient {
	const jar = new Map<string, string>();

	function cookieHeader(): string {
		return Array.from(jar.entries())
			.map(([k, v]) => `${k}=${v}`)
			.join('; ');
	}

	function absorbSetCookies(res: Response): void {
		const raw = res.headers.getSetCookie?.() ?? [];
		for (const line of raw) {
			const first = line.split(';', 1)[0];
			const eq = first.indexOf('=');
			if (eq === -1) continue;
			const name = first.slice(0, eq).trim();
			const value = first.slice(eq + 1).trim();
			jar.set(name, value);
		}
	}

	async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
		const h: Record<string, string> = { ...headers };
		if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
		const ck = cookieHeader();
		if (ck) h['Cookie'] = ck;
		const res = await fetch(`${baseURL}${path}`, {
			method,
			headers: h,
			body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
		});
		absorbSetCookies(res);
		return res;
	}

	const client: ApiClient = {
		get: (path, headers) => req('GET', path, undefined, headers),
		post: (path, body, headers) => req('POST', path, body, headers),
		put: (path, body, headers) => req('PUT', path, body, headers),
		del: (path, headers) => req('DELETE', path, undefined, headers),
		cookies: () => cookieHeader(),
		async loginAs(role, secrets) {
			// First GET to mint the anonymous cookie, then POST login to elevate role.
			await req('GET', '/api/heat');
			const res = await req('POST', '/api/auth/login', { secret: role === 'admin' ? secrets.admin : secrets.member });
			if (!res.ok) throw new Error(`loginAs(${role}) failed: ${res.status} ${await res.text()}`);
		}
	};
	return client;
}

