import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { UnsupportedSandboxPolicyError } from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { UnsupportedGrantError } from './errors.js';
import { withNativeSandbox } from './fixtures/native-sandbox.js';
import { EFFECTIVE_POLICY } from './policy.js';
import { SYSTEM_ROOTS } from './scope.js';
import { quote } from './shell.js';

const policy = { ...EFFECTIVE_POLICY, filesystemScope: 'system-read-only' };

it('reads system files but cannot discover or read a private home entry', async () => {
	const directory = await mkdtemp(path.join(homedir(), '.mxc-test-'));
	const file = path.join(directory, 'canary');

	try {
		await writeFile(file, 'private');
		await withNativeSandbox(
			{},
			async (sandbox) => {
				const result = await sandbox.exec({
					kind: 'shell',
					dialect: 'sh',
					command: `cat /etc/hosts >/dev/null && printf system; cat ${quote(file)} 2>/dev/null; ls -A ${quote(directory)} 2>/dev/null; ls -A ${quote(homedir())} 2>/dev/null | grep -Fx ${quote(path.basename(directory))}; true`
				});

				expect({
					scope: sandbox.policy.filesystemScope,
					stdout: new TextDecoder().decode(result.stdout)
				}).toStrictEqual({ scope: 'system-read-only', stdout: 'system' });
			},
			{ policy }
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it('rejects a configured grant in the host home directory', async () => {
	await withNativeSandbox(
		{ readonlyPaths: [homedir()] },
		() => expect.unreachable(),
		{
			policy,
			async verifyOpening(opening) {
				const grant = new UnsupportedGrantError(
					await realpath(homedir()),
					SYSTEM_ROOTS[process.platform] ?? []
				);
				const provider = new UnsupportedSandboxPolicyError(
					{ operation: 'open', providerId: 'mxc' },
					{ cause: grant }
				);

				await expect(opening).rejects.toStrictEqual(
					new UnsupportedSandboxPolicyError(
						{
							operation: 'open',
							configurationSource: 'extension',
							providerId: 'mxc'
						},
						{ cause: provider }
					)
				);
			}
		}
	);
});
