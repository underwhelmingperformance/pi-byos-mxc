import type {
	RecoveryDescriptor,
	SandboxOpenContext
} from 'pi-bring-your-own-sandbox/provider';
import {
	SandboxCleanupError,
	SandboxStartupError
} from 'pi-bring-your-own-sandbox/provider';
import { expect, it } from 'vitest';

import { AllocationCancelledError } from './errors.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { memoryHost } from './fixtures/host.js';
import { RecoveryStore } from './recovery.js';

const root = '/tmp/pi-byos-mxc-00000000-0000-4000-8000-000000000001';

function fixture(signal = new AbortController().signal) {
	const { host, memory } = memoryHost({ '/workspace': {} });
	const reports: { descriptor: RecoveryDescriptor; existed: boolean }[] = [];
	const context: SandboxOpenContext = {
		operationId: 'open',
		signal,
		deadline: 10_000,
		remainingMs: () => 10_000,
		cleanup: cleanupControl().cleanup,
		reportDiagnostic() {
			return;
		},
		confirmCleanup() {
			return;
		},
		reportRecovery(descriptor) {
			reports.push({ descriptor, existed: memory.existsSync(root) });
		}
	};

	return {
		memory,
		reports,
		open: () => RecoveryStore.open('/workspace', context, host)
	};
}

function records(memory: ReturnType<typeof memoryHost>['memory']) {
	return Object.fromEntries(
		memory
			.readdirSync(root)
			.map(String)
			.filter((name) => name.endsWith('.json'))
			.map((name) => [
				name,
				JSON.parse(String(memory.readFileSync(`${root}/${name}`, 'utf8')))
			])
	);
}

it('reports aggregate recovery before allocation and removes confirmed jobs', async () => {
	const { memory, reports, open } = fixture();
	const store = await open();
	const instructions: unknown = expect.stringContaining(root);

	await store.begin('job');
	await store.record({ id: 'job', supervisorPid: 42, targetPid: 43 });
	await store.confirmReleased('job');
	await store.dispose();

	expect({
		reports,
		scratch: store.scratch,
		exists: memory.existsSync(root)
	}).toStrictEqual({
		reports: [
			{
				descriptor: {
					kind: 'allocation',
					id: '00000000-0000-4000-8000-000000000001',
					lease:
						'No automatic expiry. Manual recovery is required after an unconfirmed cleanup or hard host crash.',
					instructions
				},
				existed: false
			}
		],
		scratch: `${root}/scratch`,
		exists: false
	});
});

it('retains uncertain job identities without storing execution payloads', async () => {
	const { memory, open } = fixture();
	const store = await open();

	await store.begin('job');
	await store.record({ id: 'job', supervisorPid: 42, targetPid: 43 });

	await expect(store.dispose()).rejects.toStrictEqual(
		new SandboxCleanupError({
			operation: 'dispose',
			providerId: 'mxc',
			recovery: store.recovery
		})
	);
	expect(records(memory)).toStrictEqual({
		'job.json': { id: 'job', supervisorPid: 42, targetPid: 43 }
	});
});

it('replaces a temporary record left by an interrupted update', async () => {
	const { memory, open } = fixture();
	const store = await open();

	await store.begin('job');
	memory.writeFileSync(`${root}/job.json.tmp`, '{"id":');
	await store.record({ id: 'job', supervisorPid: 42 });

	expect(records(memory)).toStrictEqual({
		'job.json': { id: 'job', supervisorPid: 42 }
	});
});

it('does not allocate after opening is cancelled', async () => {
	const controller = new AbortController();
	const { memory, open } = fixture(controller.signal);

	controller.abort();

	await expect(open()).rejects.toStrictEqual(
		new SandboxStartupError(
			{ operation: 'open', providerId: 'mxc' },
			{ cause: new AllocationCancelledError() }
		)
	);
	expect(memory.existsSync(root)).toBe(false);
});
