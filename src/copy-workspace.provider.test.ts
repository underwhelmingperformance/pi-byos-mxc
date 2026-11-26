import { execFile } from 'node:child_process';
import {
	link,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { copyWorkspace } from './copy-workspace.js';
import { cleanupControl } from './fixtures/cleanup.js';

const execute = promisify(execFile);
const entry = fileURLToPath(
	new URL('../dist/supervisor/entry.js', import.meta.url)
);

it.runIf(process.platform === 'darwin').each([
	{
		label: 'an absolute link',
		prepare: async (workspace: string, allocation: string) => {
			const target = path.join(allocation, 'outside');

			await writeFile(target, '');
			await symlink(target, path.join(workspace, 'link'));
		},
		message:
			'The workspace has an absolute symbolic link. Replace it with a relative link that resolves inside the copy, or remove it.'
	},
	{
		label: 'a link outside the copy',
		prepare: async (workspace: string, allocation: string) => {
			await writeFile(path.join(allocation, 'outside'), '');
			await symlink('../outside', path.join(workspace, 'link'));
		},
		message:
			'A symbolic link does not resolve inside the copy. Fix the link or remove it before copying.'
	},
	{
		label: 'a FIFO',
		prepare: async (workspace: string) => {
			await execute('/usr/bin/mkfifo', [path.join(workspace, 'fifo')]);
		},
		message:
			'The workspace contains a special file. Remove sockets, FIFOs and devices before copying.'
	},
	{
		label: 'a hard link',
		prepare: async (workspace: string) => {
			const source = path.join(workspace, 'source');

			await writeFile(source, '');
			await link(source, path.join(workspace, 'link'));
		},
		message:
			'The workspace contains a multiply linked regular file. Replace hard links with independent files before copying.'
	}
])(
	'maps the native snapshot refusal for $label',
	async ({ prepare, message }) => {
		const temporary = await mkdtemp(path.join(tmpdir(), 'mxc-native-refusal-'));

		try {
			const directory = await realpath(temporary);
			const workspace = path.join(directory, 'source');
			const allocation = path.join(directory, 'allocation');

			await mkdir(workspace);
			await mkdir(allocation);
			await prepare(workspace, allocation);

			await expect(
				copyWorkspace(entry, workspace, allocation, {
					operationId: 'snapshot',
					signal: new AbortController().signal,
					deadline: Date.now() + 10_000,
					remainingMs: () => 10_000,
					cleanup: cleanupControl().cleanup,
					reportRecovery: vi.fn(),
					reportDiagnostic: vi.fn(),
					confirmCleanup: vi.fn()
				})
			).rejects.toMatchObject({ name: 'SnapshotRefusalError', message });
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
);
