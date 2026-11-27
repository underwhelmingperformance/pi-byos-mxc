import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { BackendProcessContext } from 'pi-bring-your-own-sandbox/provider';
import {
	SandboxOperationError,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/provider';
import { expect, it } from 'vitest';

import { FakeClock } from '../fixtures/clock.js';

import type { JobOptions } from './client.js';
import { SupervisorJob } from './client.js';

const entry = fileURLToPath(
	new URL('../fixtures/supervisor.ts', import.meta.url)
);

function job(command: string, spawnSupervisor?: JobOptions['spawn']) {
	const controller = new AbortController();
	const output = { stdout: '', stderr: '' };
	let cleanupMs: number | undefined;
	const context: BackendProcessContext = {
		operationId: randomUUID(),
		signal: controller.signal,
		deadline: 10_000,
		remainingMs: () => 10_000,
		cleanup: { remainingMs: () => cleanupMs, deadline: undefined },
		reportDiagnostic() {
			return;
		},
		onOutput(chunk) {
			output[chunk.stream] += Buffer.from(chunk.data).toString();

			if (output.stdout !== 'ready') {
				return;
			}

			cleanupMs = 10_000;
			controller.abort();
		}
	};

	return {
		output,
		job: new SupervisorJob({
			entry,
			request: {
				version: 1,
				kind: 'start',
				id: randomUUID(),
				backend: 'seatbelt',
				network: 'ip-denied',
				hostUserData: 'denied',
				systemRoots: [],
				command,
				shell: '/bin/sh',
				cwd: '/workspace',
				readwritePaths: ['/workspace', '/scratch'],
				environment: {},
				readonlyPaths: [],
				deniedPaths: []
			},
			context,
			clock: new FakeClock(),
			groups: {
				isLeader: () => Promise.resolve(true),
				isEmpty: () => Promise.resolve(true)
			},
			record: () => Promise.resolve(),
			...(spawnSupervisor !== undefined && { spawn: spawnSupervisor })
		})
	};
}

it.each([
	{
		command: 'normal',
		expected: {
			result: { kind: 'exited', exit: { kind: 'code', code: 7 } },
			output: { stdout: '{"kind":"completed"}\n', stderr: 'target stderr' }
		}
	},
	{
		command: 'wait',
		expected: {
			result: { kind: 'cancelled', termination: 'confirmed' },
			output: { stdout: 'ready', stderr: '' }
		}
	}
])(
	'carries control messages over IPC and output over descriptors: $command',
	async ({ command, expected }) => {
		const { job: running, output } = job(command);

		expect({ result: await running.run(), output }).toStrictEqual(expected);
	}
);

it('rejects a malformed message from a real supervisor process', async () => {
	await expect(job('malformed').job.run()).rejects.toStrictEqual(
		new SandboxTransportError({ operation: 'exec', providerId: 'mxc' })
	);
});

it('reports a supervisor process that exits before receiving the job as not started', async () => {
	const { job: running } = job('normal', (command, _arguments, options) =>
		spawn(command, ['-e', 'process.exit(3)'], options)
	);

	await expect(running.run()).rejects.toStrictEqual(
		new SandboxOperationError({ operation: 'exec', providerId: 'mxc' })
	);
});
