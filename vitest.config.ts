import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// SQLite is per-file locked and each test file boots its own preview server.
		// Run files serially in a single fork to avoid port + DB clashes.
		pool: 'forks',
		fileParallelism: false
	}
});

