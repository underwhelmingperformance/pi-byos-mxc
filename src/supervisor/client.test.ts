import { randomUUID } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { BackendProcessContext } from 'pi-bring-your-own-sandbox/api';
import { expect, it, vi } from 'vitest';

import { ProcessGroups } from '../platform/process-groups.js';

import { SupervisorJob } from './client.js';

function fixture(
	command: string,
	recordGate: Promise<void> = Promise.resolve()
) {
	const controller = new AbortController();
	const output = { stdout: '', stderr: '' };
	const allocated = Promise.withResolvers<undefined>();
	const faulted = Promise.withResolvers<undefined>();
	const leadershipChecks: number[] = [];
	let cleanupDeadline: number | undefined;
	const context: BackendProcessContext = {
		operationId: randomUUID(),
		signal: controller.signal,
		deadline: Date.now() + 5000,
		cleanup: {
			get deadline() {
				return cleanupDeadline;
			}
		},
		reportDiagnostic() {
			return;
		},
		onOutput(chunk) {
			if (command === 'output-failure') {
				throw new Error('The output observer failed.');
			}

			output[chunk.stream] += Buffer.from(chunk.data).toString();

			if (output.stdout !== 'ready') {
				return;
			}

			cleanupDeadline = Date.now() + 1000;
			controller.abort();
		}
	};
	const groups = new ProcessGroups(() =>
		command === 'observer-failure'
			? Promise.reject(new Error('The process snapshot is unavailable.'))
			: Promise.resolve(command === 'live-group' ? '42 42 S\n' : '42 42 Z\n')
	);

	return {
		controller,
		output,
		allocated,
		faulted,
		leadershipChecks,
		job: new SupervisorJob({
			entry: fileURLToPath(
				new URL('../fixtures/supervisor.ts', import.meta.url)
			),
			request: {
				version: 1,
				kind: 'start',
				id: randomUUID(),
				backend: 'seatbelt',
				network: 'ip-denied',
				command,
				shell: '/bin/sh',
				cwd: '/workspace',
				workspace: '/workspace',
				scratch: '/scratch',
				environment: {},
				readonlyPaths: [],
				deadline: context.deadline
			},
			context,
			groups: {
				isLeader(pid) {
					leadershipChecks.push(pid);

					if (command === 'fault-hang') {
						faulted.resolve(undefined);

						return Promise.resolve(false);
					}

					return Promise.resolve(true);
				},
				isEmpty: (group, deadline) => groups.isEmpty(group, deadline)
			},
			record(allocation) {
				if (allocation.targetPid !== undefined) {
					allocated.resolve(undefined);
				}

				if (
					command === 'record-failure' &&
					allocation.targetPid !== undefined
				) {
					return Promise.reject(new Error('The recovery record failed.'));
				}

				return allocation.targetPid === undefined
					? Promise.resolve()
					: recordGate;
			}
		}),
		cancel: (graceMs = 50) => {
			cleanupDeadline = Date.now() + graceMs;
			controller.abort();
		}
	};
}

it.each([
	{ command: 'normal', exit: { kind: 'code', code: 7 } },
	{ command: 'unavailable', exit: { kind: 'unavailable' } }
] as const)(
	'keeps workload bytes separate from $command control results',
	async ({ command, exit }) => {
		const { job, output } = fixture(command);
		const result = await job.run();

		expect({ result, output }).toStrictEqual({
			result: { kind: 'exited', exit },
			output: { stdout: '{"kind":"completed"}\n', stderr: 'target stderr' }
		});
	}
);

it('uses the live cleanup deadline and confirms cancellation after cleanup', async () => {
	const { job, output } = fixture('wait');

	expect({ result: await job.run(), output }).toStrictEqual({
		result: { kind: 'cancelled', termination: 'confirmed' },
		output: { stdout: 'ready', stderr: '' }
	});
});

it.each([
	'malformed',
	'early-completion',
	'timeout',
	'live-group',
	'observer-failure',
	'record-failure',
	'output-failure'
])('does not invent a successful result after %s', async (command) => {
	const { job } = fixture(command);

	await expect(job.run()).rejects.toMatchObject({
		name:
			command === 'timeout' ? 'SandboxTimeoutError' : 'SandboxTransportError'
	});
});

it('rejects oversized control payloads before allocation', async () => {
	const { job } = fixture('x'.repeat(1_048_577));

	await expect(job.run()).rejects.toMatchObject({
		name: 'InvalidSandboxRequestError'
	});
});

it('bounds an unresponsive child without claiming target termination', async () => {
	const { job, allocated, cancel } = fixture('hang');
	const running = job.run();
	const rejected = expect(running).rejects.toMatchObject({
		name: 'SandboxTransportError',
		completion: 'unknown'
	});

	await allocated.promise;
	cancel();
	await rejected;
});

it('does not extend a transport-failure cleanup budget when the caller later cancels', async () => {
	vi.useFakeTimers({
		toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout']
	});

	const { job, faulted, cancel } = fixture('fault-hang');
	const running = job.run();
	let hasRejected = false;

	async function record(): Promise<void> {
		await expect(running).rejects.toMatchObject({
			name: 'SandboxTransportError',
			completion: 'unknown'
		});
		hasRejected = true;
	}

	const recorded = record();

	try {
		await faulted.promise;
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(1000);
		cancel(10_000);
		await vi.advanceTimersByTimeAsync(4001);
		expect(hasRejected).toBe(true);
	} finally {
		try {
			await vi.advanceTimersByTimeAsync(20_000);
			await recorded;
		} finally {
			vi.useRealTimers();
		}
	}
});

it.each(['cleanup-failure', 'completed-then-failed', 'duplicate-completion'])(
	'rejects contradictory or failed finalisation without diagnostic bytes: %s',
	async (command) => {
		const { job, output } = fixture(command);

		await expect(job.run()).rejects.toMatchObject({
			name: 'SandboxTransportError',
			completion: 'unknown'
		});

		const expected =
			command === 'cleanup-failure'
				? { stdout: '', stderr: '' }
				: { stdout: '{"kind":"completed"}\n', stderr: 'target stderr' };

		expect({
			stdoutIsTargetPrefix: expected.stdout.startsWith(output.stdout),
			stderrIsTargetPrefix: expected.stderr.startsWith(output.stderr)
		}).toStrictEqual({
			stdoutIsTargetPrefix: true,
			stderrIsTargetPrefix: true
		});
	}
);

it('does not release a target after recovery recording finishes beyond cancellation', async () => {
	const gate = Promise.withResolvers<undefined>();
	const { job, allocated, cancel, leadershipChecks, output } = fixture(
		'hang',
		gate.promise
	);
	const running = job.run();
	const rejected = expect(running).rejects.toMatchObject({
		name: 'SandboxTransportError',
		completion: 'unknown'
	});

	try {
		await allocated.promise;
		cancel();
		await rejected;
		gate.resolve(undefined);
		await yieldImmediate();
		expect({ leadershipChecks, output }).toStrictEqual({
			leadershipChecks: [],
			output: { stdout: '', stderr: '' }
		});
		expect(job.run()).toBe(running);
	} finally {
		gate.resolve(undefined);
		await rejected;
	}
});
