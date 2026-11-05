import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	RecoveryDescriptor,
	SandboxOpenContext
} from 'pi-bring-your-own-sandbox/api';
import { afterEach, expect, it } from 'vitest';

import { RecoveryStore } from './recovery.js';

const cleanup: string[] = [];

afterEach(async () => {
	for (const directory of cleanup.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function fixture() {
	const workspace = await mkdtemp(
		path.join(tmpdir(), 'pi-byos-mxc-workspace-')
	);

	cleanup.push(workspace);

	let reported: RecoveryDescriptor | undefined;
	let existedAtReport: boolean | undefined;
	const context: SandboxOpenContext = {
		operationId: 'open',
		signal: new AbortController().signal,
		deadline: Date.now() + 10_000,
		cleanup: { deadline: undefined },
		reportDiagnostic() {
			return;
		},
		confirmCleanup() {
			return;
		},
		reportRecovery(descriptor) {
			reported = descriptor;
			existedAtReport =
				descriptor.kind === 'allocation' &&
				existsSync(path.join(tmpdir(), `pi-byos-mxc-${descriptor.id}`));
		}
	};
	const store = await RecoveryStore.open(workspace, context);

	cleanup.push(store.root);

	return { store, reported, existedAtReport };
}

it('reports aggregate recovery before use and removes confirmed allocations', async () => {
	const { store, reported, existedAtReport } = await fixture();
	const instructions: unknown = expect.stringContaining(store.root);

	expect({ reported, existedAtReport }).toStrictEqual({
		reported: {
			kind: 'allocation',
			id: path.basename(store.root).slice('pi-byos-mxc-'.length),
			lease:
				'No automatic expiry. Manual recovery is required after an unconfirmed cleanup or hard host crash.',
			instructions
		},
		existedAtReport: false
	});
	await store.begin('job');
	await store.record({ id: 'job', supervisorPid: 42, targetPid: 43 });
	await store.confirmReleased('job');
	await store.dispose();
	await expect(access(store.root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains uncertain job identities without storing execution payloads', async () => {
	const { store } = await fixture();

	await store.begin('job');
	await store.record({ id: 'job', supervisorPid: 42, targetPid: 43 });
	await expect(store.dispose()).rejects.toMatchObject({
		name: 'SandboxCleanupError'
	});

	const saved = await readFile(path.join(store.root, 'job.json'), 'utf8');
	const record: unknown = JSON.parse(saved);

	expect(record).toStrictEqual({
		id: 'job',
		supervisorPid: 42,
		targetPid: 43
	});
});
