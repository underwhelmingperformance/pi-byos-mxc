import type {
	RecoveryDescriptor,
	SandboxOpenContext,
	SandboxPolicy
} from 'pi-bring-your-own-sandbox/provider';
import { UnsupportedSandboxPolicyError } from 'pi-bring-your-own-sandbox/provider';
import { expect, it } from 'vitest';

import { validateConfig } from './config.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { defaultPolicy, fixtureProfile } from './fixtures/profiles.js';
import { provider } from './provider.js';

it('offers the copy operation exactly when it declares copy profiles', () => {
	expect(typeof provider.copy).toBe(
		provider.profiles.copy.length > 0 ? 'function' : 'undefined'
	);
});

it.each<SandboxPolicy>([{ ...defaultPolicy, hostSystemFiles: 'denied' }])(
	'rejects unsupported policy before allocation: %j',
	async (policy) => {
		const recoveries: RecoveryDescriptor[] = [];
		let isConfirmed = false;
		const context: SandboxOpenContext = {
			operationId: 'open',
			signal: new AbortController().signal,
			deadline: 1000,
			remainingMs: () => 10_000,
			cleanup: cleanupControl().cleanup,
			reportDiagnostic() {
				return;
			},
			confirmCleanup() {
				isConfirmed = true;
			},
			reportRecovery(recovery) {
				recoveries.push(recovery);
			}
		};

		await expect(
			provider.open(
				{
					generationId: 'test',
					sessionId: 'test',
					hostWorkspace: '/does-not-exist',
					profile: { ...fixtureProfile(), policy },
					configuration: validateConfig({})
				},
				context
			)
		).rejects.toStrictEqual(
			new UnsupportedSandboxPolicyError({
				operation: 'open',
				providerId: 'mxc'
			})
		);
		expect({ recoveries, isConfirmed }).toStrictEqual({
			recoveries: [{ kind: 'none' }],
			isConfirmed: true
		});
	}
);
