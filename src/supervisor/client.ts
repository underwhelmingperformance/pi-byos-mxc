import type { SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessExit
} from 'pi-bring-your-own-sandbox/provider';
import {
	InvalidSandboxRequestError,
	SandboxOperationError,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/provider';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import { ProcessGroups, PS_LOCATIONS } from '../platform/process-groups.js';
import { SYSTEM_PATH } from '../shell.js';

import type { ChildMessage, ParentMessage, StartMessage } from './protocol.js';
import { childMessage, MAX_START_BYTES } from './protocol.js';

// BYOS publishes a cleanup allowance before it aborts an operation. When the job
// stops after its own failure, such as a transport failure, BYOS has not
// published an allowance, so the job uses this one. It matches BYOS's default
// cancellation grace.
const FAILURE_CLEANUP_MS = 5000;

function listLocations(locations: readonly string[]): string {
	return `${locations.slice(0, -1).join(', ')} or ${locations.at(-1) ?? ''}`;
}

function processExit(
	message: Extract<ChildMessage, { kind: 'completed' }>
): ProcessExit {
	if (message.signalNumber !== undefined) {
		const signal = Object.entries(constants.signals).find(
			([, number]) => number === message.signalNumber
		);

		if (!signal) {
			throw new Error('The exit observer reported an unknown signal.');
		}

		return {
			kind: 'signal',
			signal: signal[0],
			signalNumber: message.signalNumber
		};
	}

	return message.exitCode === -1
		? { kind: 'unavailable' }
		: { kind: 'code', code: message.exitCode };
}

export interface JobAllocation {
	readonly id: string;
	readonly supervisorPid: number;
	readonly targetPid?: number;
}

/**
The parts of a child process that the job uses. Node's `ChildProcess`
satisfies it.
*/
export interface SupervisorProcess {
	readonly pid?: number | undefined;
	readonly connected: boolean;
	readonly stdio: readonly (Readable | Writable | null | undefined)[];
	send(
		message: ParentMessage,
		callback: (error?: Error | null) => void
	): boolean;
	kill(signal: NodeJS.Signals): boolean;
	on(event: 'error', listener: (error: Error) => void): this;
	on(event: 'close', listener: (code?: number | null) => void): this;
	on(event: 'message', listener: (message: unknown) => void): this;
}

export interface JobOptions {
	readonly entry: string;
	readonly input?: Uint8Array;
	readonly request: StartMessage;
	readonly context: BackendProcessContext;
	readonly record: (allocation: JobAllocation) => Promise<void>;
	readonly groups?: Pick<ProcessGroups, 'isLeader' | 'isEmpty'>;
	readonly clock?: Clock;
	readonly spawn?: (
		command: string,
		childArguments: readonly string[],
		options: SpawnOptions
	) => SupervisorProcess;
}

/**
Runs one command through a supervisor process. BYOS aborts the context signal
at the operation deadline. The job then has the published cleanup allowance to
confirm that the target stopped.
*/
export class SupervisorJob {
	readonly #options: JobOptions;
	readonly #groups: Pick<ProcessGroups, 'isLeader' | 'isEmpty'>;
	readonly #clock: Clock;
	readonly #result = Promise.withResolvers<BackendProcessOutcome>();
	readonly #closed = Promise.withResolvers<boolean>();
	#child: SupervisorProcess | undefined;
	#output: Promise<unknown> = Promise.resolve();
	#cancelTimer: (() => void) | undefined;
	#cleanupExpiresAt: number | undefined;
	#targetPid: number | undefined;
	#hasSentStart = false;
	#hasSentCancel = false;
	#hasCompletion = false;
	#isReleased = false;
	#isFinished = false;
	#hasFailure = false;
	#messages: Promise<undefined> = Promise.resolve(undefined);
	#pendingMessages = 0;

	readonly #cancel = (): void => {
		if (this.#isFinished) {
			return;
		}

		this.#arm(this.#cleanupExpiry());
		this.#stop();
	};

	constructor(options: JobOptions) {
		this.#options = options;
		this.#groups = options.groups ?? new ProcessGroups();
		this.#clock = options.clock ?? systemClock;
	}

	#failure(): SandboxTransportError | SandboxOperationError {
		if (this.#hasSentStart) {
			return new SandboxTransportError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		return new SandboxOperationError({ operation: 'exec', providerId: 'mxc' });
	}

	#stop(): void {
		if (!this.#hasSentStart) {
			this.#child?.kill('SIGKILL');

			return;
		}

		if (this.#hasSentCancel) {
			return;
		}

		this.#hasSentCancel = true;
		this.#send({ version: 1, kind: 'cancel', id: this.#options.request.id });
	}

	#send(message: ParentMessage): void {
		const child = this.#child;

		if (!child?.connected || this.#isFinished) {
			this.#reject();

			return;
		}

		child.send(message, (error) => {
			if (error) {
				this.#reject();
			}
		});
	}

	#clear(): void {
		this.#isFinished = true;
		this.#cancelTimer?.();
		this.#options.context.signal.removeEventListener('abort', this.#cancel);
	}

	#reject(): void {
		if (this.#isFinished) {
			return;
		}

		this.#clear();
		this.#child?.kill('SIGKILL');
		this.#result.reject(this.#failure());
	}

	#cleanupExpiry(): number {
		return (
			this.#clock.monotonicTime() +
			(this.#options.context.cleanup.remainingMs() ?? FAILURE_CLEANUP_MS)
		);
	}

	#expire(): void {
		if (
			this.#cleanupExpiresAt !== undefined &&
			this.#clock.monotonicTime() < this.#cleanupExpiresAt
		) {
			this.#arm(this.#cleanupExpiresAt);

			return;
		}

		this.#reject();
	}

	#arm(expiresAt: number): void {
		const cleanupExpiresAt = Math.min(
			this.#cleanupExpiresAt ?? expiresAt,
			expiresAt
		);

		this.#cleanupExpiresAt = cleanupExpiresAt;
		this.#cancelTimer?.();
		this.#cancelTimer = this.#clock.schedule(() => {
			this.#expire();
		}, cleanupExpiresAt - this.#clock.monotonicTime());
	}

	#fail(): void {
		if (this.#isFinished || this.#hasFailure) {
			return;
		}

		this.#hasFailure = true;
		this.#arm(this.#cleanupExpiry());

		if (this.#hasSentStart) {
			this.#stop();

			return;
		}

		this.#reject();
	}

	async #ready(): Promise<void> {
		const pid = this.#child?.pid;

		if (pid === undefined || this.#hasSentStart) {
			this.#fail();

			return;
		}

		await this.#options.record({
			id: this.#options.request.id,
			supervisorPid: pid
		});

		if (this.#isFinished || this.#options.context.signal.aborted) {
			return;
		}

		this.#hasSentStart = true;
		this.#send(this.#options.request);
	}

	#reportUnreadableProcesses(): void {
		this.#options.context.reportDiagnostic({
			level: 'warning',
			message: `MXC could not read the host process table, so it cannot confirm the state of the command's process group. Check that ps is available at ${listLocations(PS_LOCATIONS)}.`
		});
	}

	#canRelease(): boolean {
		return (
			!this.#isFinished &&
			!this.#options.context.signal.aborted &&
			!this.#hasFailure
		);
	}

	async #started(pid: number): Promise<void> {
		const supervisorPid = this.#child?.pid;

		if (supervisorPid === undefined || this.#targetPid !== undefined) {
			this.#fail();

			return;
		}

		this.#targetPid = pid;
		await this.#options.record({
			id: this.#options.request.id,
			supervisorPid,
			targetPid: pid
		});

		if (!this.#canRelease()) {
			return;
		}

		const isLeader = await this.#groups.isLeader(pid);

		if (isLeader === undefined) {
			this.#reportUnreadableProcesses();
		}

		if (isLeader !== true) {
			this.#fail();

			return;
		}

		if (!this.#canRelease()) {
			return;
		}

		this.#isReleased = true;
		this.#send({ version: 1, kind: 'release', id: this.#options.request.id });
	}

	async #complete(
		message: ChildMessage & { kind: 'completed' }
	): Promise<void> {
		if (!this.#hasSentStart || this.#targetPid === undefined) {
			this.#reject();

			return;
		}

		const wasClosedNormally = await this.#closed.promise;

		await this.#output;

		const context = this.#options.context;
		const hasStopped =
			!this.#isReleased || (await this.#groups.isEmpty(this.#targetPid));

		if (this.#isFinished) {
			return;
		}

		if (hasStopped === undefined) {
			this.#reportUnreadableProcesses();
		}

		if (!wasClosedNormally || !hasStopped || this.#hasFailure) {
			this.#reject();

			return;
		}

		if (message.warnings > 0) {
			context.reportDiagnostic({
				level: 'warning',
				message: `MXC reported ${String(message.warnings)} runtime warning(s). Check the pinned backend's documented limitations.`
			});
		}

		this.#clear();

		if (context.signal.aborted) {
			this.#result.resolve({ kind: 'cancelled', termination: 'confirmed' });

			return;
		}

		this.#result.resolve({ kind: 'exited', exit: processExit(message) });
	}

	async #receive(message: ChildMessage): Promise<void> {
		if (this.#isFinished) {
			return;
		}

		if (message.kind === 'ready') {
			await this.#ready();

			return;
		}

		if (message.id !== this.#options.request.id) {
			this.#fail();

			return;
		}

		if (message.kind === 'started') {
			await this.#started(message.pid);

			return;
		}

		if (message.kind === 'completed') {
			await this.#complete(message);

			return;
		}

		this.#fail();
	}

	async #enqueue(message: ChildMessage): Promise<void> {
		if (this.#pendingMessages >= 8) {
			this.#fail();

			return;
		}

		const previous = this.#messages;
		const queued = Promise.withResolvers<undefined>();

		this.#pendingMessages++;
		this.#messages = queued.promise;

		try {
			await previous;
			await this.#receive(message);
		} catch {
			this.#fail();
		} finally {
			this.#pendingMessages--;
			queued.resolve(undefined);
		}
	}

	limitCleanup(remainingMs: number): void {
		if (this.#isFinished || this.#cleanupExpiresAt === undefined) {
			return;
		}

		this.#arm(this.#clock.monotonicTime() + remainingMs);
	}

	run(): Promise<BackendProcessOutcome> {
		if (this.#child !== undefined) {
			return this.#result.promise;
		}

		if (
			Buffer.byteLength(JSON.stringify(this.#options.request)) > MAX_START_BYTES
		) {
			return Promise.reject(
				new InvalidSandboxRequestError({ operation: 'exec', providerId: 'mxc' })
			);
		}

		const context = this.#options.context;

		if (context.signal.aborted) {
			return Promise.resolve({ kind: 'cancelled', termination: 'confirmed' });
		}

		const launch = this.#options.spawn ?? spawn;
		const child = launch(
			process.execPath,
			[this.#options.entry, this.#options.request.id],
			{
				cwd: path.dirname(this.#options.entry),
				stdio: [
					this.#options.input === undefined ? 'ignore' : 'pipe',
					'ignore',
					'ignore',
					'ipc',
					'pipe',
					'pipe'
				],
				env: { PATH: SYSTEM_PATH }
			}
		);

		this.#child = child;

		const input = child.stdio[0];

		if (this.#options.input !== undefined && input instanceof Writable) {
			input.on('error', (error: NodeJS.ErrnoException) => {
				if (error.code !== 'EPIPE') {
					this.#fail();
				}
			});
			input.end(this.#options.input);
		}

		child.on('error', () => {
			this.#reject();
		});
		child.on('close', (code) => {
			this.#closed.resolve(code === 0);

			if (!this.#hasSentStart && context.signal.aborted && !this.#isFinished) {
				this.#clear();
				this.#result.resolve({ kind: 'cancelled', termination: 'confirmed' });

				return;
			}

			if (!this.#hasCompletion) {
				this.#reject();
			}
		});

		const streams = child.stdio.slice(4);

		if (streams.length !== 2) {
			this.#reject();

			return this.#result.promise;
		}

		const drains: Promise<unknown>[] = [];

		for (const [index, stream] of streams.entries()) {
			if (!(stream instanceof Readable)) {
				this.#reject();

				return this.#result.promise;
			}

			stream.on('data', (data: Buffer) => {
				if (this.#isFinished || this.#hasFailure) {
					return;
				}

				try {
					context.onOutput({ stream: index === 0 ? 'stdout' : 'stderr', data });
				} catch {
					this.#fail();
				}
			});
			drains.push(finished(stream));
		}

		this.#output = Promise.all(drains);
		void this.#output.catch(() => {
			this.#fail();
		});
		child.on('message', (input: unknown) => {
			if (this.#isFinished) {
				return;
			}

			if (!childMessage.Check(input) || this.#hasCompletion) {
				this.#fail();

				return;
			}

			if (input.kind === 'completed') {
				this.#hasCompletion = true;
			}

			void this.#enqueue(input);
		});
		context.signal.addEventListener('abort', this.#cancel, { once: true });

		return this.#result.promise;
	}
}
