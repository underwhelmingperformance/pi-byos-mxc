import type {
	RecoveryDescriptor,
	SandboxOpenContext,
	SandboxPolicy
} from 'pi-bring-your-own-sandbox/api';
import { UnsupportedSandboxPolicyError } from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { validateConfig } from './config.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { EFFECTIVE_POLICY } from './policy.js';
import { provider } from './provider.js';

it('advertises process-group shell execution and delegated policy defaults', () => {
	expect({
		id: provider.id,
		protocolVersion: provider.protocolVersion,
		capabilities: provider.capabilities,
		policies: provider.policies,
		defaultPolicy: provider.defaultPolicy
	}).toStrictEqual({
		id: 'mxc',
		protocolVersion: 1,
		capabilities: {
			operations: [
				'exec',
				'workspace.protection',
				'files.read',
				'files.list',
				'files.write'
			],
			processKinds: ['shell'],
			shells: ['sh', 'bash'],
			exitStatus: 'optional',
			terminationScope: 'process-group'
		},
		policies: {
			workspaceAccess: ['read-write', 'read-only'],
			filesystemScope: ['provider-default', 'system-read-only'],
			networkAccess:
				process.platform === 'darwin'
					? ['provider-default', 'denied']
					: ['provider-default']
		},
		defaultPolicy: EFFECTIVE_POLICY
	});
});

it.each<SandboxPolicy>([
	{ ...EFFECTIVE_POLICY, filesystemScope: 'workspace-only' }
])('rejects unsupported policy before allocation: %j', async (policy) => {
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
				policy,
				configuration: validateConfig({})
			},
			context
		)
	).rejects.toStrictEqual(
		new UnsupportedSandboxPolicyError({ operation: 'open', providerId: 'mxc' })
	);
	expect({ recoveries, isConfirmed }).toStrictEqual({
		recoveries: [{ kind: 'none' }],
		isConfirmed: true
	});
});
