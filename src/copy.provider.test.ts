import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	SandboxBackend,
	SandboxCopySource,
	SandboxOpenContext,
	SandboxOpenRequest
} from 'pi-bring-your-own-sandbox/api';
import { assert, expect, it, vi } from 'vitest';

import { validateConfig } from './config.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { withNativeSandbox } from './fixtures/native-sandbox.js';
import { provider } from './provider.js';

it.runIf(process.platform === 'darwin')(
	'keeps independent read-only copies of the host and live MXC destination',
	async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), 'mxc-review-project-'));
		const context: SandboxOpenContext = {
			operationId: 'snapshot',
			signal: new AbortController().signal,
			deadline: Date.now() + 60_000,
			remainingMs: () => 60_000,
			cleanup: cleanupControl().cleanup,
			reportRecovery: vi.fn(),
			reportDiagnostic: vi.fn(),
			confirmCleanup: vi.fn()
		};
		const request = {
			generationId: 'editing',
			sessionId: 'test',
			hostWorkspace: workspace,
			configuration: validateConfig({}),
			policy: {
				workspaceAccess: 'read-write',
				filesystemScope: 'provider-default',
				networkAccess: 'provider-default'
			} as const
		};
		const allocated: SandboxBackend[] = [];
		const copy = provider.copy;

		assert.isDefined(copy);

		const policy = {
			workspaceRelationship: 'copied',
			workspaceAccess: 'read-only',
			filesystemScope: 'system-read-only',
			networkAccess: 'denied'
		} as const;
		const review = (
			source: SandboxCopySource
		): SandboxOpenRequest<ReturnType<typeof validateConfig>> & {
			source: SandboxCopySource;
		} => ({ ...request, generationId: 'review', policy, source });
		const host = review({ kind: 'host' });
		const file = path.join(workspace, 'notes');
		const locked = path.join(workspace, 'locked');

		try {
			await mkdir(locked);
			await writeFile(path.join(locked, 'nested'), 'read only');
			await chmod(locked, 0o555);
			await writeFile(file, 'draft');
			await expect(
				copy(
					{ ...host, policy: { ...policy, filesystemScope: 'workspace-only' } },
					context
				)
			).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });

			const editor = await provider.open(request, context);

			allocated.push(editor);

			const first = await copy(host, context);

			allocated.push(first);
			await writeFile(file, 'saved');

			const second = await copy(
				review({
					kind: 'backend',
					backend: editor
				}),
				context
			);

			allocated.push(second);
			await writeFile(file, 'newer');
			assert.isDefined(first.files?.read);
			assert.isDefined(second.files?.read);
			assert.isDefined(first.files.write);

			const firstPath = path.join(first.workspace.root, 'notes');
			const secondPath = path.join(second.workspace.root, 'notes');

			await expect(
				first.files.write.writeFile(firstPath, Buffer.from('change'), context)
			).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });

			const shell: Buffer[] = [];

			await first.exec(
				{ kind: 'shell', dialect: 'sh', command: 'cat notes' },
				{
					...context,
					onOutput(chunk) {
						if (chunk.stream === 'stdout') {
							shell.push(Buffer.from(chunk.data));
						}
					}
				}
			);
			expect({
				relationship: first.workspace.relationship,
				original: Buffer.from(
					await first.files.read.readFile(firstPath, context)
				).toString(),
				shell: Buffer.concat(shell).toString(),
				updated: Buffer.from(
					await second.files.read.readFile(secondPath, context)
				).toString(),
				host: await readFile(file, 'utf8')
			}).toStrictEqual({
				relationship: 'copied',
				original: 'draft',
				shell: 'draft',
				updated: 'saved',
				host: 'newer'
			});

			for (const [backend, sessionId] of [
				[{ ...editor }, 'test'],
				[editor, 'other']
			] as const) {
				const checked = { ...context, reportRecovery: vi.fn() };

				await expect(
					copy({ ...review({ kind: 'backend', backend }), sessionId }, checked)
				).rejects.toMatchObject({ name: 'StaleSandboxHandleError' });
				expect(checked.reportRecovery.mock.calls).toStrictEqual([
					[{ kind: 'none' }]
				]);
			}

			await first.dispose(context);

			const closing = { ...context, reportRecovery: vi.fn() };

			await expect(
				copy(review({ kind: 'backend', backend: first }), closing)
			).rejects.toMatchObject({ name: 'StaleSandboxHandleError' });
			expect(closing.reportRecovery.mock.calls).toStrictEqual([
				[{ kind: 'none' }]
			]);
			await expect(stat(first.workspace.root)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			expect(
				await readFile(path.join(second.workspace.root, 'notes'), 'utf8')
			).toBe('saved');

			const moved = workspace + '-moved';

			await rename(workspace, moved);

			try {
				const nested = await copy(
					review({ kind: 'backend', backend: second }),
					context
				);

				allocated.push(nested);
				expect(
					await readFile(path.join(nested.workspace.root, 'notes'), 'utf8')
				).toBe('saved');
			} finally {
				await rename(moved, workspace);
			}
		} finally {
			try {
				await Promise.all(allocated.map((backend) => backend.dispose(context)));
			} finally {
				await chmod(locked, 0o700);
				await rm(workspace, { recursive: true, force: true });
			}
		}
	}
);

it.runIf(process.platform === 'darwin').each([
	{
		needs: ['workspace-writes'],
		filesystemScope: 'system-read-only',
		networkAccess: 'denied'
	},
	{
		needs: ['workspace-writes', 'network', 'host-user-data'],
		filesystemScope: 'provider-default',
		networkAccess: 'provider-default'
	}
] as const)(
	'copies writes from the parent allocation with $needs',
	async ({ needs, filesystemScope, networkAccess }) => {
		await withNativeSandbox({}, async (editor, workspace) => {
			const file = path.join(workspace, 'notes');

			await writeFile(file, 'host');

			const parent = await editor.copy({
				needs,
				workspaceProtection: [{ kind: 'path', path: 'protected' }]
			});

			try {
				const local = path.join(parent.sandbox.workspace.root, 'notes');

				await parent.sandbox.files.writeFile(local, Buffer.from('parent'));
				await expect(
					parent.sandbox.files.writeFile(
						path.join(parent.sandbox.workspace.root, 'protected'),
						Buffer.from('edit')
					)
				).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });

				const child = await parent.sandbox.copy();

				try {
					await parent.sandbox.files.writeFile(local, Buffer.from('later'));

					const content = await child.sandbox.files.readFile(
						path.join(child.sandbox.workspace.root, 'notes')
					);

					expect({
						parentDescription: parent.sandbox.workspace.description,
						childDescription: child.sandbox.workspace.description,
						parent: parent.sandbox.policy,
						child: child.sandbox.policy,
						copied: Buffer.from(content).toString(),
						host: await readFile(file, 'utf8')
					}).toMatchObject({
						parentDescription:
							'Private writable workspace copy. Changes stay in the copy until disposal.',
						childDescription: 'Private read-only workspace copy.',
						parent: {
							workspaceAccess: 'read-write',
							networkAccess,
							filesystemScope
						},
						child: {
							workspaceAccess: 'read-only',
							networkAccess: 'denied',
							filesystemScope: 'system-read-only'
						},
						copied: 'parent',
						host: 'host'
					});
				} finally {
					await child.close();
				}
			} finally {
				await parent.close();
			}
		});
	}
);
