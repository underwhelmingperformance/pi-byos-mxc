import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	SandboxBackend,
	SandboxOpenContext,
	SandboxOpenRequest
} from 'pi-bring-your-own-sandbox/api';
import { assert, expect, it, vi } from 'vitest';

import { validateConfig } from './config.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { provider } from './provider.js';
import type { ReviewSource } from './review-snapshot.js';

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
		const openSnapshot = provider.openReviewSnapshot;

		assert.isDefined(openSnapshot);

		const policy = {
			workspaceRelationship: 'copied',
			workspaceAccess: 'read-only',
			filesystemScope: 'system-read-only',
			networkAccess: 'denied'
		} as const;
		const review = (
			source: ReviewSource
		): SandboxOpenRequest<ReturnType<typeof validateConfig>> & {
			source: ReviewSource;
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
				openSnapshot(
					{ ...host, policy: { ...policy, filesystemScope: 'workspace-only' } },
					context
				)
			).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });

			const editor = await provider.open(
				{
					...request,
					policy: {
						workspaceAccess: 'read-write',
						filesystemScope: 'provider-default',
						networkAccess: 'provider-default'
					}
				},
				context
			);

			allocated.push(editor);

			const first = await openSnapshot(host, context);

			allocated.push(first);
			await writeFile(file, 'saved');

			const second = await openSnapshot(
				review({
					kind: 'sandbox',
					providerId: 'mxc',
					generationId: 'editing',
					backendId: editor.id
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
			await first.dispose(context);
			await expect(stat(first.workspace.root)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			expect(
				await readFile(path.join(second.workspace.root, 'notes'), 'utf8')
			).toBe('saved');
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
