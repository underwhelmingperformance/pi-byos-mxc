import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { withNativeSandbox } from './fixtures/native-sandbox.js';
import { EFFECTIVE_POLICY } from './policy.js';

it('shares atomic host replacements with a running shell and file tools', async () => {
	await withNativeSandbox({}, async (sandbox, workspace) => {
		const file = path.join(workspace, 'notes');
		const temporary = path.join(workspace, 'replacement');
		const ready = Promise.withResolvers<boolean>();
		const stop = new AbortController();
		const output: Buffer[] = [];
		const running = sandbox.exec(
			{
				kind: 'shell',
				dialect: 'sh',
				command:
					'printf draft > notes && printf ready && while [ "$(cat notes)" = draft ]; do sleep 0.1; done && cat notes'
			},
			{
				signal: stop.signal,
				timeoutMs: 10_000,
				onOutput(chunk) {
					if (chunk.stream !== 'stdout') {
						return;
					}

					output.push(Buffer.from(chunk.data));

					if (Buffer.concat(output).toString() === 'ready') {
						ready.resolve(true);
					}
				}
			}
		);

		try {
			expect(await Promise.race([ready.promise, running])).toBe(true);
			expect(await readFile(file, 'utf8')).toBe('draft');
			await writeFile(temporary, 'reviewed');
			await rename(temporary, file);

			const result = await running;

			expect({
				workspace: sandbox.workspace.relationship,
				shell: Buffer.from(result.stdout).toString(),
				files: Buffer.from(await sandbox.files.readFile(file)).toString()
			}).toStrictEqual({
				workspace: 'shared',
				shell: 'readyreviewed',
				files: 'reviewed'
			});
		} finally {
			stop.abort();
			await Promise.allSettled([running]);
		}
	});
});

it('protects a host replacement on the next tool call', async () => {
	await withNativeSandbox(
		{},
		async (sandbox, workspace) => {
			const file = path.join(workspace, '.envrc');
			const replacement = path.join(workspace, 'replacement');

			await writeFile(replacement, 'host edit');
			await rename(replacement, file);
			await expect(
				sandbox.files.writeFile(file, Buffer.from('tool edit'))
			).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });
			await sandbox.files.writeFile(
				path.join(workspace, 'notes'),
				Buffer.from('saved')
			);

			const contents = await Promise.all([
				readFile(file, 'utf8'),
				readFile(path.join(workspace, 'notes'), 'utf8')
			]);

			expect(contents).toStrictEqual(['host edit', 'saved']);
		},
		{
			policy: {
				...EFFECTIVE_POLICY,
				workspaceProtection: [{ kind: 'path', path: '.envrc' }]
			},
			prepareWorkspace: async (workspace) =>
				writeFile(path.join(workspace, '.envrc'), 'original')
		}
	);
});
