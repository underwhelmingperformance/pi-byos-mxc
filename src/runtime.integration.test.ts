import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { validateConfig } from './config.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { systemHost } from './host.js';
import { prepareRuntime } from './runtime.js';

const supervisor = fileURLToPath(
	new URL('supervisor/entry.ts', import.meta.url)
);
const context = {
	operationId: 'runtime',
	signal: new AbortController().signal,
	deadline: 1000,
	remainingMs: () => 10_000,
	cleanup: cleanupControl().cleanup,
	reportDiagnostic() {
		return;
	},
	reportRecovery() {
		return;
	},
	confirmCleanup() {
		return;
	}
};

function prepare(workspace: string) {
	return prepareRuntime(workspace, validateConfig({}), context, {
		host: systemHost,
		supervisor
	});
}

it('accepts a workspace outside the installed runtime', async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), 'pi-byos-mxc-runtime-'));

	try {
		const runtime = await prepare(workspace);

		expect({
			entry: runtime.entry,
			workspace: runtime.workspace
		}).toStrictEqual({
			entry: await realpath(supervisor),
			workspace: await realpath(workspace)
		});
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
