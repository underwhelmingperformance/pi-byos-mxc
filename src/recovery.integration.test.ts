import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { cleanupControl } from './fixtures/cleanup.js';
import { systemHost } from './host.js';
import { RecoveryStore } from './recovery.js';

it('creates private recovery files on the host filesystem', async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), 'pi-byos-mxc-recovery-'));

	try {
		const store = await RecoveryStore.open(
			workspace,
			{
				operationId: 'open',
				signal: new AbortController().signal,
				deadline: 10_000,
				remainingMs: () => 10_000,
				cleanup: cleanupControl().cleanup,
				reportDiagnostic() {
					return;
				},
				confirmCleanup() {
					return;
				},
				reportRecovery() {
					return;
				}
			},
			systemHost
		);

		await store.begin('job');

		const metadata = await Promise.all(
			[store.root, store.scratch, path.join(store.root, 'job.json')].map(
				(filename) => stat(filename)
			)
		);

		await store.confirmReleased('job');
		await store.dispose();

		expect({
			parent: path.dirname(store.root),
			modes: metadata.map(({ mode }) => mode & 0o777)
		}).toStrictEqual({
			parent: await realpath(tmpdir()),
			modes: [0o700, 0o700, 0o600]
		});
		await expect(stat(store.root)).rejects.toMatchObject({ code: 'ENOENT' });
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
