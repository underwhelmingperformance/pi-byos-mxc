import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
	SandboxPolicy,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/api';
import {
	getSandbox,
	initialiseSandboxHost,
	registerSandboxProvider,
	SandboxStartupError
} from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import type { MxcConfig } from './config.js';
import { CommandChecks } from './fixtures/command-checks.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { legacySettings } from './legacy-settings.js';
import { EFFECTIVE_POLICY } from './policy.js';
import { provider } from './provider.js';

it.each([
	{
		label: 'declared default',
		policy: undefined,
		expected: [EFFECTIVE_POLICY],
		error: 'SandboxStartupError'
	},
	{
		label: 'complete explicit policy',
		policy: EFFECTIVE_POLICY,
		expected: [EFFECTIVE_POLICY],
		error: 'SandboxStartupError'
	},
	{
		label: 'unsupported explicit policy',
		policy: { ...EFFECTIVE_POLICY, filesystemScope: 'workspace-only' },
		expected: [],
		error: 'UnsupportedSandboxPolicyError'
	},
	{
		label: 'partial explicit policy',
		policy: { workspaceAccess: 'read-write' },
		expected: [],
		error: 'InvalidSandboxConfigError'
	}
])(
	'selects the MXC policy without fallback: $label',
	async ({ policy, expected, error }) => {
		let agentDirectory = '';
		const checks = new CommandChecks();
		const requests: SandboxPolicy[] = [];
		const unavailable: SandboxProvider<MxcConfig> = {
			...provider,
			open(request, context) {
				requests.push(request.policy);
				context.reportRecovery({ kind: 'none' });
				context.confirmCleanup();

				return Promise.reject(
					new SandboxStartupError({ operation: 'open', providerId: 'mxc' })
				);
			}
		};

		await withPiRuntime(
			[
				{
					name: 'policy-fixture',
					factory(pi) {
						initialiseSandboxHost(pi, {});
						registerSandboxProvider(pi, unavailable, {
							configure: () => {
								const settings = legacySettings(agentDirectory);

								if (!settings) {
									throw new Error('Missing test settings.');
								}

								return settings;
							}
						});
						pi.registerCommand('verify-policy', {
							description: 'Verify policy selection without native allocation.',
							handler: (_arguments, context) =>
								checks.run(async () => {
									await expect(getSandbox(pi, context)).rejects.toMatchObject({
										name: error
									});
								})
						});
					}
				}
			],
			async (runtime, errors) => {
				await runtime.session.prompt('/verify-policy');
				checks.verify(1);
				expect({ requests, errors }).toStrictEqual({
					requests: expected,
					errors: []
				});
			},
			{
				async prepare(_directory, personal) {
					agentDirectory = personal;
					await writeFile(
						path.join(personal, 'byos.json'),
						JSON.stringify({ provider: 'mxc', policy })
					);
				}
			}
		);
	}
);
