import { randomUUID } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

import type { SandboxDiagnostic } from 'pi-bring-your-own-sandbox/host';
import type { BackendProcessContext } from 'pi-bring-your-own-sandbox/provider';
import {
	InvalidSandboxRequestError,
	SandboxOperationError,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/provider';
import { expect, it } from 'vitest';

import { ProcessTableUnavailableError } from '../errors.js';
import { FakeClock } from '../fixtures/clock.js';
import { InjectedFailure } from '../fixtures/errors.js';
import { fakeSupervisor } from '../fixtures/supervisor-process.js';
import { ProcessGroups } from '../platform/process-groups.js';

import type { JobOptions } from './client.js';
import { SupervisorJob } from './client.js';

const transportFailure = new SandboxTransportError({
	operation: 'exec',
	providerId: 'mxc'
});

function fixture(
	command: string,
	recordGate: Promise<void> = Promise.resolve(),
	spawnSupervisor: JobOptions['spawn'] = fakeSupervisor()
) {
	const clock = new FakeClock();
	const controller = new AbortController();
	const output = { stdout: '', stderr: '' };
	const allocated = Promise.withResolvers<undefined>();
	const faulted = Promise.withResolvers<undefined>();
	const leadershipChecks: number[] = [];
	const diagnostics: SandboxDiagnostic[] = [];
	let cleanupExpiresAt: number | undefined;
	const startCleanup = (graceMs: number) => {
		cleanupExpiresAt = clock.monotonicTime() + graceMs;
		controller.abort();
	};

	const context: BackendProcessContext = {
		operationId: randomUUID(),
		signal: controller.signal,
		deadline: 5000,
		remainingMs: () => Math.max(0, 5000 - clock.monotonicTime()),
		cleanup: {
			remainingMs: () =>
				cleanupExpiresAt === undefined
					? undefined
					: Math.max(0, cleanupExpiresAt - clock.monotonicTime()),
			get deadline() {
				return cleanupExpiresAt;
			}
		},
		reportDiagnostic(diagnostic) {
			diagnostics.push(diagnostic);
		},
		onOutput(chunk) {
			if (command === 'output-failure') {
				throw new InjectedFailure('output');
			}

			output[chunk.stream] += Buffer.from(chunk.data).toString();

			if (output.stdout !== 'ready') {
				return;
			}

			startCleanup(1000);
		}
	};
	const groups = new ProcessGroups(
		() =>
			command === 'observer-failure'
				? Promise.reject(new ProcessTableUnavailableError(['/bin/ps']))
				: Promise.resolve(command === 'live-group' ? '42 42 S\n' : '42 42 Z\n'),
		() => 'unknown'
	);

	return {
		clock,
		output,
		allocated,
		faulted,
		leadershipChecks,
		diagnostics,
		job: new SupervisorJob({
			entry: '/fixture/supervisor.js',
			request: {
				version: 1,
				kind: 'start',
				id: randomUUID(),
				backend: 'seatbelt',
				network: 'ip-denied',
				command,
				shell: '/bin/sh',
				cwd: '/workspace',
				readwritePaths: ['/workspace', '/scratch'],
				environment: {},
				readonlyPaths: [],
				deniedPaths: []
			},
			context,
			clock,
			spawn: spawnSupervisor,
			groups: {
				isLeader(pid) {
					leadershipChecks.push(pid);

					if (command === 'fault-hang') {
						faulted.resolve(undefined);

						return Promise.resolve(false);
					}

					return Promise.resolve(true);
				},
				isEmpty: (group) => groups.isEmpty(group)
			},
			record(allocation) {
				if (allocation.targetPid !== undefined) {
					allocated.resolve(undefined);
				}

				if (
					command === 'record-failure' &&
					allocation.targetPid !== undefined
				) {
					return Promise.reject(new InjectedFailure('record'));
				}

				return allocation.targetPid === undefined
					? Promise.resolve()
					: recordGate;
			}
		}),
		cancel: (graceMs = 50) => {
			startCleanup(graceMs);
		}
	};
}

function settlement(promise: Promise<unknown>): () => boolean {
	let isSettled = false;

	void (async () => {
		try {
			await promise;
		} catch {
			return;
		} finally {
			isSettled = true;
		}
	})();

	return () => isSettled;
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

it('uses the live cleanup allowance and confirms cancellation after cleanup', async () => {
	const { job, output } = fixture('wait');

	expect({ result: await job.run(), output }).toStrictEqual({
		result: { kind: 'cancelled', termination: 'confirmed' },
		output: { stdout: 'ready', stderr: '' }
	});
});

it('leaves the operation deadline to the caller signal', async () => {
	const { job, allocated, clock, cancel } = fixture('sleep');
	const running = job.run();
	const isSettled = settlement(running);

	await allocated.promise;
	clock.advance(60_000);
	await yieldImmediate();
	expect(isSettled()).toBe(false);

	cancel(1000);
	expect(await running).toStrictEqual({
		kind: 'cancelled',
		termination: 'confirmed'
	});
});

it.each([
	'malformed',
	'early-completion',
	'live-group',
	'observer-failure',
	'record-failure',
	'output-failure'
])('does not invent a successful result after %s', async (command) => {
	const { job } = fixture(command);

	await expect(job.run()).rejects.toStrictEqual(transportFailure);
});

it('rejects oversized control payloads before allocation', async () => {
	const { job } = fixture('x'.repeat(1_048_577));

	await expect(job.run()).rejects.toStrictEqual(
		new InvalidSandboxRequestError({ operation: 'exec', providerId: 'mxc' })
	);
});

it('stops waiting for an unresponsive child when the cleanup allowance ends', async () => {
	const { job, allocated, clock, cancel } = fixture('hang');
	const running = job.run();
	const isSettled = settlement(running);

	await allocated.promise;
	cancel(50);
	clock.advance(49);
	await yieldImmediate();
	expect(isSettled()).toBe(false);

	clock.advance(1);
	await expect(running).rejects.toStrictEqual(transportFailure);
});

it('shortens the cleanup allowance when disposal limits it', async () => {
	const { job, allocated, clock, cancel } = fixture('hang');
	const running = job.run();
	const isSettled = settlement(running);

	await allocated.promise;
	cancel(1000);
	job.limitCleanup(50);
	clock.advance(49);
	await yieldImmediate();
	expect(isSettled()).toBe(false);

	clock.advance(1);
	await expect(running).rejects.toStrictEqual(transportFailure);
});

it('does not extend a transport-failure cleanup budget when the caller later cancels', async () => {
	const { job, faulted, clock, cancel } = fixture('fault-hang');
	const running = job.run();
	const isSettled = settlement(running);

	await faulted.promise;
	await yieldImmediate();
	clock.advance(1000);
	cancel(10_000);
	clock.advance(3999);
	await yieldImmediate();
	expect(isSettled()).toBe(false);

	clock.advance(1);
	await expect(running).rejects.toStrictEqual(transportFailure);
});

it.each(['cleanup-failure', 'completed-then-failed', 'duplicate-completion'])(
	'rejects contradictory or failed finalisation without diagnostic bytes: %s',
	async (command) => {
		const { job, output } = fixture(command);

		await expect(job.run()).rejects.toStrictEqual(transportFailure);

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
	const { job, allocated, clock, cancel, leadershipChecks, output } = fixture(
		'hang',
		gate.promise
	);
	const running = job.run();
	const rejected = expect(running).rejects.toStrictEqual(transportFailure);

	try {
		await allocated.promise;
		cancel(50);
		clock.advance(50);
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

it('reports a supervisor that exits before receiving the job as not started', async () => {
	const { job } = fixture(
		'normal',
		undefined,
		fakeSupervisor((_port, child) => {
			child.exit(3);
		})
	);

	await expect(job.run()).rejects.toStrictEqual(
		new SandboxOperationError({ operation: 'exec', providerId: 'mxc' })
	);
});

it('explains an unreadable process table before reporting unknown completion', async () => {
	const { job, diagnostics } = fixture('observer-failure');

	await expect(job.run()).rejects.toStrictEqual(transportFailure);
	expect(diagnostics).toStrictEqual([
		{
			level: 'warning',
			message:
				"MXC could not read the host process table, so it cannot confirm the state of the command's process group. Check that ps is available at /bin/ps, /usr/bin/ps or /run/current-system/sw/bin/ps."
		}
	]);
});
