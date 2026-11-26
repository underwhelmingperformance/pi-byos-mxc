import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SandboxOpenContext } from 'pi-bring-your-own-sandbox/api';
import { expect, it, vi } from 'vitest';

import { copyWorkspace } from './copy-workspace.js';
import { cleanupControl } from './fixtures/cleanup.js';

it.each([
	[
		2,
		'The workspace exceeds 100,000 entries. Remove generated files before copying.'
	],
	[
		3,
		'The workspace exceeds 128 levels of nesting. Move or remove deeply nested entries before copying.'
	],
	[
		4,
		'The workspace exceeds 512 MiB of regular file data. Move or remove large files before copying.'
	],
	[
		5,
		'The workspace has an absolute symbolic link. Replace it with a relative link that resolves inside the copy, or remove it.'
	],
	[
		6,
		'A symbolic link does not resolve inside the copy. Fix the link or remove it before copying.'
	],
	[
		7,
		'The workspace crosses a mount. Unmount it or copy a workspace on a single filesystem.'
	],
	[
		8,
		'The workspace has an immutable or append-only entry. Remove the flags or move the entry before copying.'
	],
	[
		9,
		'The workspace contains a special file. Remove sockets, FIFOs and devices before copying.'
	],
	[
		10,
		'The workspace contains a multiply linked regular file. Replace hard links with independent files before copying.'
	],
	[
		11,
		'The workspace changed while MXC was copying it. Stop the processes that modify it and retry.'
	],
	[
		12,
		'A path in the copy exceeds the system path length limit. Shorten the path before copying.'
	],
	[
		13,
		'The copy requires file cloning on the same filesystem. Move the workspace to a filesystem that supports cloning and contains the temporary directory.'
	]
])(
	'reports snapshot refusal %i without exposing helper output',
	async (status, message) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'mxc-copy-refusal-'));
		const context: SandboxOpenContext = {
			operationId: 'snapshot',
			signal: new AbortController().signal,
			deadline: Date.now() + 10_000,
			remainingMs: () => 10_000,
			cleanup: cleanupControl().cleanup,
			reportRecovery: vi.fn(),
			reportDiagnostic: vi.fn(),
			confirmCleanup: vi.fn()
		};

		try {
			await mkdir(path.join(directory, 'native'));
			await writeFile(
				path.join(directory, 'native/snapshot'),
				`#!/bin/sh\nprintf 'private fixture path' >&2\nexit ${status}\n`,
				{ mode: 0o700 }
			);

			const copying = copyWorkspace(
				path.join(directory, 'supervisor/entry.js'),
				'/fixture-workspace',
				directory,
				context
			);

			await expect(copying).rejects.toMatchObject({
				name: 'SnapshotRefusalError',
				message
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);
