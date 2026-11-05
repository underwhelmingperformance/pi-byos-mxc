import { readdir, readFile, realpath } from 'node:fs/promises';
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

async function homeFile(): Promise<string | undefined> {
	const entries = await readdir(homedir(), { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}

		const filename = path.join(homedir(), entry.name);

		try {
			await readFile(filename);

			return filename;
		} catch {
			continue;
		}
	}

	return undefined;
}

const probe = await homeFile();

it.skipIf(probe === undefined)(
	'reads system files but not host home files',
	async () => {
		const target = quote(probe ?? '');

		await withNativeSandbox(
			{},
			async (sandbox) => {
				const result = await sandbox.exec({
					kind: 'shell',
					dialect: 'sh',
					command: `cat /etc/hosts >/dev/null && printf system; cat ${target} >/dev/null 2>&1 && printf home; ls ${quote(homedir())} >/dev/null 2>&1 && printf listing; true`
				});

				expect({
					scope: sandbox.policy.filesystemScope,
					stdout: new TextDecoder().decode(result.stdout)
				}).toStrictEqual({ scope: 'system-read-only', stdout: 'system' });
			},
			{ policy }
		);
	}
);

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
							configurationSource: 'personal',
							providerId: 'mxc'
						},
						{ cause: provider }
					)
				);
			}
		}
	);
});
