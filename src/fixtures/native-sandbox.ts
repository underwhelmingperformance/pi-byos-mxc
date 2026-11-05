import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Sandbox } from 'pi-bring-your-own-sandbox/api';
import {
	getSandbox,
	initialiseSandboxHost
} from 'pi-bring-your-own-sandbox/api';
import { expect } from 'vitest';

import type { MxcConfig } from '../config.js';
import mxc from '../extension.js';
import { EFFECTIVE_POLICY } from '../policy.js';

import { CommandChecks } from './command-checks.js';
import { withPiRuntime } from './pi-runtime.js';

export async function withNativeSandbox(
	config: Partial<MxcConfig>,
	check: (sandbox: Sandbox, workspace: string) => Promise<void>
): Promise<void> {
	let agentDirectory = '';
	const checks = new CommandChecks();

	await withPiRuntime(
		[
			{
				name: 'host',
				factory(pi) {
					initialiseSandboxHost(pi, { agentDirectory });
				}
			},
			{ name: 'mxc', factory: mxc },
			{
				name: 'consumer',
				factory(pi) {
					pi.registerCommand('verify-native', {
						description: 'Verify a native MXC boundary.',
						handler: (_arguments, context) =>
							checks.run(async () => {
								await check(await getSandbox(pi, context), context.cwd);
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
			async prepare(_directory, personal) {
				agentDirectory = personal;
				await writeFile(
					path.join(personal, 'byos.json'),
					JSON.stringify({
						provider: 'mxc',
						policy: EFFECTIVE_POLICY,
						providerConfig: config,
						cleanup: { cancellationGraceMs: 10_000, disposalTimeoutMs: 15_000 }
					})
				);
			}
		}
	);
}

function literal(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function nodeCommand(script: string): string {
	return `${literal(process.execPath)} -e ${literal(script)}`;
}
