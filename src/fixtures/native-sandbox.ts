import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
	Sandbox,
	SandboxAcquireOptions
} from 'pi-bring-your-own-sandbox/consumer';
import { createSandboxClient } from 'pi-bring-your-own-sandbox/consumer';
import { initialiseSandboxHost } from 'pi-bring-your-own-sandbox/host';
import { expect } from 'vitest';

import type { MxcSettings } from '../config.js';
import mxc from '../extension.js';
import { SETTINGS_FILE } from '../settings.js';
import { quote } from '../shell.js';

import { CommandChecks } from './command-checks.js';
import { withPiRuntime } from './pi-runtime.js';

interface NativeSandboxOptions {
	/**
	The configured policy. Omission uses the SDK default.
	*/
	readonly policy?: unknown;
	readonly requirements?: SandboxAcquireOptions;

	/**
	Prepares the workspace before Pi starts.
	*/
	readonly prepareWorkspace?: (workspace: string) => Promise<void>;

	/**
	Receives the acquisition instead of `check`, for tests that expect opening
	to fail.
	*/
	readonly verifyOpening?: (opening: Promise<Sandbox>) => Promise<void>;
}

export async function withNativeSandbox(
	config: Partial<MxcSettings>,
	check: (sandbox: Sandbox, workspace: string) => Promise<void>,
	options: NativeSandboxOptions = {}
): Promise<void> {
	const checks = new CommandChecks();

	await withPiRuntime(
		[
			{
				name: 'host',
				factory(pi) {
					initialiseSandboxHost(pi, import.meta.filename, {});
				}
			},
			{ name: 'mxc', factory: mxc },
			{
				name: 'consumer',
				factory(pi) {
					const client = createSandboxClient(pi, import.meta.filename);

					pi.registerCommand('verify-native', {
						description: 'Verify a native MXC boundary.',
						handler: (_arguments, context) =>
							checks.run(async () => {
								if (options.requirements) {
									const negotiation = await client.negotiate(
										context,
										options.requirements
									);

									expect(negotiation.ok).toBe(true);
								}

								const opening = client.get(context, options.requirements);

								if (options.verifyOpening !== undefined) {
									await options.verifyOpening(opening);

									return;
								}

								await check(await opening, context.cwd);
							})
					});
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/verify-native');
			checks.verify(1);
			expect(errors).toStrictEqual([]);
		},
		{
			async prepare(directory, personal) {
				await options.prepareWorkspace?.(directory);
				await writeFile(
					path.join(personal, SETTINGS_FILE),
					JSON.stringify({
						...config,
						policy: options.policy,
						cleanup: { cancellationGraceMs: 10_000, disposalTimeoutMs: 15_000 }
					})
				);
			}
		}
	);
}

export function nodeCommand(script: string): string {
	return `${quote(process.execPath)} -e ${quote(script)}`;
}
