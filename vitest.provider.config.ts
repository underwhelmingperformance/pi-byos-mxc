import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['src/**/*.provider.test.ts'], testTimeout: 15_000 }
});
