import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.provider.test.ts'],
		maxWorkers: 2,
		testTimeout: 15_000
	}
});
