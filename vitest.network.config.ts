import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['src/**/*.external.test.ts'], testTimeout: 15_000 }
});
