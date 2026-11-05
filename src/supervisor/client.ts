import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import type {
	BackendProcessContext,
	BackendProcessOutcome
} from 'pi-bring-your-own-sandbox/api';
import {
	InvalidSandboxRequestError,
	SandboxTimeoutError,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/api';

import { ProcessGroups } from '../platform/process-groups.js';

import type { ChildMessage, ParentMessage, StartMessage } from './protocol.js';
import { childMessage } from './protocol.js';

export interface JobAllocation {
	readonly id: string;
	readonly supervisorPid: number;
	readonly targetPid?: number;
}

export interface JobOptions {
	readonly entry: string;
	readonly request: StartMessage;
	readonly context: BackendProcessContext;
	readonly record: (allocation: JobAllocation) => Promise<void>;
	readonly groups?: Pick<ProcessGroups, 'isLeader' | 'isEmpty'>;
	readonly spawn?: (
		command: string,
		childArguments: readonly string[],
		options: SpawnOptions
	) => ChildProcess;
}

export class SupervisorJob {
	readonly #options: JobOptions;
	readonly #groups: Pick<ProcessGroups, 'isLeader' | 'isEmpty'>;
	readonly #result = Promise.withResolvers<BackendProcessOutcome>();
	readonly #closed = Promise.withResolvers<boolean>();
	#child: ChildProcess | undefined;
	#output: Promise<unknown> = Promise.resolve();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#expiresAt = 0;
	#cleanupExpiresAt: number | undefined;
	#targetPid: number | undefined;
	#hasSentStart = false;
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

		const context = this.#options.context;
		const deadline = context.cleanup.deadline ?? context.deadline;

		this.#arm(deadline, 'cleanup');

		if (!this.#hasSentStart) {
			this.#child?.kill('SIGKILL');

			return;
		}

		this.#send({
			version: 1,
			kind: 'cancel',
			id: this.#options.request.id,
			deadline
		});
	};

	constructor(options: JobOptions) {
		this.#options = options;
		this.#groups = options.groups ?? new ProcessGroups();
	}

	#transportError(): SandboxTransportError {
		return new SandboxTransportError({ operation: 'exec', providerId: 'mxc' });
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
		clearTimeout(this.#timer);
		this.#options.context.signal.removeEventListener('abort', this.#cancel);
	}

	#reject(): void {
		if (this.#isFinished) {
			return;
		}

		this.#clear();
		this.#child?.kill('SIGKILL');
		this.#result.reject(this.#transportError());
	}

	#schedule(): void {
		clearTimeout(this.#timer);

		const remaining = this.#expiresAt - performance.now();

		if (remaining <= 0) {
			this.#reject();

			return;
		}

		this.#timer = setTimeout(
			() => {
				this.#schedule();
			},
			Math.min(remaining, 2_147_483_647)
		);
	}

	#arm(deadline: number, phase: 'execution' | 'cleanup' = 'execution'): void {
		let expiresAt = performance.now() + Math.max(0, deadline - Date.now());

		if (phase === 'cleanup') {
			expiresAt = Math.min(this.#cleanupExpiresAt ?? expiresAt, expiresAt);
			this.#cleanupExpiresAt = expiresAt;
		}

		this.#expiresAt = expiresAt;
		this.#schedule();
	}

	#fail(): void {
		if (this.#isFinished || this.#hasFailure) {
			return;
		}

		this.#hasFailure = true;

		const deadline =
			this.#options.context.cleanup.deadline ??
			Math.min(this.#options.context.deadline, Date.now() + 5000);

		this.#arm(deadline, 'cleanup');

		if (this.#hasSentStart) {
			this.#send({
				version: 1,
				kind: 'cancel',
				id: this.#options.request.id,
				deadline
			});

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

	#canRelease(): boolean {
		return (
			!this.#isFinished &&
			!this.#options.context.signal.aborted &&
			!this.#hasFailure &&
			performance.now() < this.#expiresAt &&
			Date.now() < this.#options.context.deadline
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

		if (!(await this.#groups.isLeader(pid, this.#options.context.deadline))) {
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
		const deadline = context.cleanup.deadline ?? context.deadline;
		const hasStopped =
			!this.#isReleased ||
			(await this.#groups.isEmpty(this.#targetPid, deadline));

		if (this.#isFinished) {
			return;
		}

		if (
			!wasClosedNormally ||
			!hasStopped ||
			this.#hasFailure ||
			performance.now() >= this.#expiresAt
		) {
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

		if (message.timedOut) {
			this.#result.reject(
				new SandboxTimeoutError({ operation: 'exec', completion: 'confirmed' })
			);

			return;
		}

		this.#result.resolve({
			kind: 'exited',
			exit:
				message.exitCode === -1
					? { kind: 'unavailable' }
					: { kind: 'code', code: message.exitCode }
		});
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

	limitCleanup(deadline: number): void {
		if (this.#isFinished || this.#cleanupExpiresAt === undefined) {
			return;
		}

		this.#arm(deadline, 'cleanup');
	}

	run(): Promise<BackendProcessOutcome> {
		if (this.#child !== undefined) {
			return this.#result.promise;
		}

		if (Buffer.byteLength(JSON.stringify(this.#options.request)) > 1_048_576) {
			return Promise.reject(
				new InvalidSandboxRequestError({ operation: 'exec', providerId: 'mxc' })
			);
		}

		const context = this.#options.context;

		if (context.signal.aborted) {
			return Promise.resolve({ kind: 'cancelled', termination: 'confirmed' });
		}

		if (context.deadline <= Date.now()) {
			return Promise.reject(
				new SandboxTimeoutError({
					operation: 'exec',
					completion: 'not-started'
				})
			);
		}

		const launch = this.#options.spawn ?? spawn;
		const child = launch(
			process.execPath,
			[this.#options.entry, this.#options.request.id],
			{
				cwd: path.dirname(this.#options.entry),
				stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
				env: { PATH: '/bin:/usr/bin:/usr/sbin:/sbin' }
			}
		);

		this.#child = child;

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
		this.#arm(context.cleanup.deadline ?? context.deadline);

		return this.#result.promise;
	}
}
