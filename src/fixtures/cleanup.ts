import type { SandboxCleanupContext } from 'pi-bring-your-own-sandbox/provider';

/**
A BYOS cleanup context for tests. Its `remainingMs()` returns `undefined` until
the test calls `publish`. The broker's cleanup context behaves the same way
before it cancels an operation.
*/
export function cleanupControl() {
	let allowance: number | undefined;
	const cleanup: SandboxCleanupContext = {
		remainingMs: () => allowance,
		deadline: undefined
	};

	return {
		cleanup,
		publish(remainingMs: number): void {
			allowance = remainingMs;
		}
	};
}
