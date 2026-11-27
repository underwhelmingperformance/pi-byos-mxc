import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SandboxTransportError } from 'pi-bring-your-own-sandbox/provider';
import { expect, it } from 'vitest';

import { cleanupControl } from '../fixtures/cleanup.js';

import { SupervisorJob } from './client.js';

it('ends the supervisor after an invalid start message', async () => {
	const job = new SupervisorJob({
		entry: fileURLToPath(
			new URL('../../dist/supervisor/entry.js', import.meta.url)
		),
		request: {
			version: 1,
			kind: 'start',
			id: randomUUID(),
			backend: 'seatbelt',
			network: 'ip-denied',
			hostUserData: 'denied',
			systemRoots: [],
			command: 'true',
			shell: '/bin/sh',
			cwd: 'relative',
			readwritePaths: [],
			environment: {},
			readonlyPaths: [],
			deniedPaths: []
		},
		context: {
			operationId: randomUUID(),
			signal: new AbortController().signal,
			deadline: 10_000,
			remainingMs: () => 10_000,
			cleanup: cleanupControl().cleanup,
			reportDiagnostic() {
				return;
			},
			onOutput() {
				return;
			}
		},
		record: () => Promise.resolve()
	});

	await expect(job.run()).rejects.toStrictEqual(
		new SandboxTransportError({ operation: 'exec', providerId: 'mxc' })
	);
});
