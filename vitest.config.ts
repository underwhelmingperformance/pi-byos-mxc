import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		exclude: [
			'src/**/*.integration.test.ts',
			'src/**/*.provider.test.ts',
			'src/**/*.external.test.ts'
		]
	}
});
