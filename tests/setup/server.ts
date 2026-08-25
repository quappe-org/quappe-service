import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface RunningServer {
	baseURL: string;
	stop: () => Promise<void>;
	dbPath: string;
	adminSecret: string;
}

async function pickPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, () => {
			const port = (srv.address() as { port: number }).port;
			srv.close(() => resolve(port));
		});
	});
}

async function waitForReady(baseURL: string, timeoutMs = 45_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown = null;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseURL}/api/heat`);
			if (res.ok) return;
			lastErr = new Error(`status ${res.status}`);
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`Server not ready after ${timeoutMs}ms — last error: ${String(lastErr)}`);
}

/**
 * Boot a real quappe-service via `vite dev` on a random port with a temp SQLite DB.
 * Returns baseURL + stop() for the test to hit. Ensures no seed data (empty DB) so
 * tests set up their own fixtures deterministically.
 */
export async function startServer(): Promise<RunningServer> {
	const port = await pickPort();
	const artifactsDir = join(process.cwd(), 'tests', '.artifacts');
	mkdirSync(artifactsDir, { recursive: true });
	const dbPath = join(artifactsDir, `quappe-test-${process.pid}-${port}.db`);
	// Clear leftovers from a crashed previous run.
	for (const suffix of ['', '-wal', '-shm']) {
		const p = dbPath + suffix;
		if (existsSync(p)) unlinkSync(p);
	}

	const adminSecret = 'test-admin-secret';
	const env: NodeJS.ProcessEnv = {
		...process.env,
		QUAPPE_DB_PATH: dbPath,
		QUAPPE_ADMIN_SECRET: adminSecret,
		QUAPPE_SECRET: 'test-jwt-secret-min-16-chars-long',
		// `gated` avoids the dev-seeder firing on the first request — tests want a clean DB.
		AUTH_MODE: 'gated',
		QUAPPE_ACCESS_SECRET: 'test-member-secret',
		NODE_ENV: 'test',
		PORT: String(port)
	};

	const child: ChildProcess = spawn('npx', ['vite', 'dev', '--port', String(port), '--host', '127.0.0.1'], {
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		cwd: process.cwd()
	});

	// Buffer child output for diagnostics on failure.
	const logs: string[] = [];
	child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
	child.stderr?.on('data', (chunk) => logs.push(String(chunk)));

	const baseURL = `http://127.0.0.1:${port}`;

	try {
		await waitForReady(baseURL);
	} catch (err) {
		child.kill('SIGKILL');
		throw new Error(`${(err as Error).message}\n--- server logs ---\n${logs.join('')}`);
	}

	return {
		baseURL,
		dbPath,
		adminSecret,
		async stop() {
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null) return resolve();
				child.once('exit', () => resolve());
				child.kill('SIGTERM');
				setTimeout(() => {
					if (child.exitCode === null) child.kill('SIGKILL');
				}, 3000);
			});
			for (const suffix of ['', '-wal', '-shm']) {
				const p = dbPath + suffix;
				if (existsSync(p)) {
					try {
						unlinkSync(p);
					} catch {
						// best effort
					}
				}
			}
		}
	};
}
