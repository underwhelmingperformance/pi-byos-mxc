import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createSandboxClient } from 'pi-bring-your-own-sandbox/consumer';
import { initialiseSandboxHost } from 'pi-bring-your-own-sandbox/host';
import type {
	SandboxPolicy,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/provider';
import {
	registerSandboxProvider,
	SandboxStartupError
} from 'pi-bring-your-own-sandbox/provider';
import { expect, it, vi } from 'vitest';

import type { MxcConfig, MxcSettings } from './config.js';
import { CommandChecks } from './fixtures/command-checks.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { defaultPolicy } from './fixtures/profiles.js';
import { systemHost } from './host.js';
import { profilesFor } from './policy.js';
import { provider } from './provider.js';
import { readSettings, SETTINGS_FILE } from './settings.js';

const explicit = { ...defaultPolicy, hostWorkspaceWrites: false };
const valid = {
	policy: explicit,
	allowEscalation: false,
	userShell: 'bash',
	cleanup: { cancellationGraceMs: 10_000, disposalTimeoutMs: 15_000 },
	shells: { sh: '/bin/sh' },
	protectPaths: ['.husky'],
	environment: { LANG: 'C.UTF-8' }
};

interface SettingsCase {
	readonly label: string;
	readonly contents?: string | undefined;
	readonly expected: readonly SandboxPolicy[];
	readonly error: string;
	readonly parsed?: unknown;
	readonly paths?: readonly string[];
	readonly causeName?: string;
}

it.each<SettingsCase>([
	{
		label: 'missing settings file',
		contents: undefined,
		expected: [defaultPolicy],
		error: 'SandboxStartupError',
		parsed: { configuration: {}, settings: {} }
	},
	{
		label: 'explicit shared and provider settings',
		contents: JSON.stringify(valid),
		expected: [explicit],
		error: 'SandboxStartupError',
		parsed: {
			configuration: {
				shells: valid.shells,
				protectPaths: valid.protectPaths,
				environment: valid.environment
			},
			settings: {
				policy: valid.policy,
				userShell: valid.userShell,
				cleanup: valid.cleanup,
				allowEscalation: valid.allowEscalation
			}
		}
	},
	{
		label: 'unsupported policy',
		contents: JSON.stringify({
			policy: { ...explicit, hostSystemFiles: 'denied' }
		}),
		expected: [],
		error: 'UnsupportedSandboxPolicyError'
	},
	{
		label: 'partial policy',
		contents: '{"policy":{"network":false}}',
		expected: [],
		error: 'InvalidSandboxConfigError',
		paths: ['/policy']
	},
	{
		label: 'malformed JSON',
		contents: '{"policy":',
		expected: [],
		error: 'InvalidSandboxConfigError',
		causeName: 'SettingsFileSyntaxError'
	},
	...(
		[
			['legacy mode', '{"mode":"strict"}', '/mode'],
			['legacy network', '{"network":"off"}', '/network'],
			['legacy path grants', '{"readonlyPaths":["/opt"]}', '/readonlyPaths'],
			['invalid shell', '{"userShell":"invalid"}', '/userShell'],
			[
				'relative protection traversal',
				'{"protectPaths":["../outside"]}',
				'/protectPaths/0'
			],
			['non-object input', '[]', '']
		] as const
	).map(([label, contents, pointer]) => ({
		label,
		contents,
		expected: [],
		error: 'InvalidSandboxConfigError',
		paths: [pointer]
	}))
])(
	'configures without fallback: $label',
	async ({ contents, expected, error, parsed, paths, causeName }) => {
		let agentDirectory = '';
		const checks = new CommandChecks();
		const requests: SandboxPolicy[] = [];
		let observed: unknown;
		const unavailable: SandboxProvider<MxcConfig> = {
			...provider,
			open(request, context) {
				requests.push(request.profile.policy);
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
						initialiseSandboxHost(pi, import.meta.filename, {});

						const client = createSandboxClient(pi, import.meta.filename);

						registerSandboxProvider<MxcConfig, MxcSettings>(
							pi,
							import.meta.filename,
							unavailable,
							{
								async configure(_context, schema) {
									const result = await readSettings(
										systemHost.fs,
										agentDirectory,
										schema
									);

									observed = result;

									return result;
								}
							}
						);
						pi.registerCommand('verify-policy', {
							description: 'Verify policy selection without native allocation.',
							handler: (_arguments, context) =>
								checks.run(async () => {
									await expect(client.get(context)).rejects.toMatchObject({
										name: error,
										...(paths !== undefined && {
											detail: {
												kind: 'config',
												field: paths.join(', ') || SETTINGS_FILE
											},
											cause: { cause: { paths } }
										}),
										...(causeName !== undefined && {
											cause: { cause: { name: causeName } }
										})
									});
								})
						});
					}
				}
			],
			async (runtime, errors) => {
				await runtime.session.prompt('/verify-policy');
				checks.verify(1);
				expect({
					requests,
					errors,
					...(parsed !== undefined && { parsed: observed })
				}).toStrictEqual({
					requests: expected,
					errors: [],
					...(parsed !== undefined && { parsed })
				});
			},
			{
				async prepare(_directory, personal) {
					agentDirectory = personal;

					if (contents !== undefined) {
						await writeFile(path.join(personal, SETTINGS_FILE), contents);
					}
				}
			}
		);
	}
);

it('refuses a Linux host user data requirement before allocating a backend', async () => {
	const checks = new CommandChecks();
	const open = vi.fn(provider.open);

	await withPiRuntime(
		[
			{
				name: 'linux-provider',
				factory(pi) {
					const client = createSandboxClient(pi, import.meta.filename);

					registerSandboxProvider<MxcConfig, MxcSettings>(
						pi,
						import.meta.filename,
						{
							id: provider.id,
							label: provider.label,
							profiles: profilesFor('linux'),
							validateConfig: provider.validateConfig,
							open
						},
						{
							configure: () => ({
								configuration: {},
								settings: {
									policy: { ...defaultPolicy, hostUserData: 'read-only' }
								}
							})
						}
					);

					pi.registerCommand('verify-linux-policy', {
						description:
							'Verify Linux negotiation without allocating a backend.',
						handler: (_arguments, context) =>
							checks.run(async () => {
								const options = { access: { hostUserData: 'needed' } } as const;
								const result = await client.negotiate(context, options);

								expect(result).toMatchObject({
									ok: false,
									error: {
										name: 'UnsupportedSandboxPolicyError',
										detail: {
											kind: 'access',
											property: 'hostUserData',
											value: 'needed',
											reason: 'profile'
										}
									}
								});
								await expect(
									client.get(context, options)
								).rejects.toMatchObject({
									name: 'UnsupportedSandboxPolicyError'
								});
							})
					});
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/verify-linux-policy');
			checks.verify(1);
			expect({ opens: open.mock.calls, errors }).toStrictEqual({
				opens: [],
				errors: []
			});
		}
	);
});
