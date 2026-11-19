import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { MxcProcess } from '@microsoft/mxc-sdk/v1';
import { spawn } from '@microsoft/mxc-sdk/v1';

import {
	ControlChannelClosedError,
	MissingStandardStreamsError,
	StopNotAcknowledgedError
} from '../errors.js';
import { networkPolicy } from '../policy.js';
import { SYSTEM_PATH, transportCommand } from '../shell.js';

import { isParentMessage } from './parent-message.js';
import type { ChildMessage, StartMessage } from './protocol.js';
import { offlineProfile } from './seatbelt.js';
import { ExitObserver } from './status.js';

class MxcSupervisor {
	#job: StartMessage | undefined;
	#target: MxcProcess | undefined;
	#input: Writable | undefined;
	#isCancelled = false;
	#isReleased = false;
	#hasStopFailure = false;

	#send(message: ChildMessage): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!process.connected || process.send === undefined) {
				reject(new ControlChannelClosedError());

				return;
			}

			process.send(message, (error) => {
				if (error) {
					reject(error);

					return;
				}

				resolve();
			});
		});
	}

	#stop(): void {
		this.#isCancelled = true;

		try {
			this.#target?.kill();
		} catch {
			this.#hasStopFailure = true;
		}
	}

	async #execute(request: StartMessage): Promise<void> {
		let observer: ExitObserver | undefined;

		try {
			const isOffline = request.network === 'denied';

			if (isOffline && request.backend !== 'seatbelt') {
				throw new Error('Strict networking requires Seatbelt.');
			}

			this.#target = await spawn(
				{
					containment: isOffline
						? {
								type: 'seatbelt',
								config: { profileOverride: offlineProfile(request) }
							}
						: { type: request.backend },
					command: transportCommand({
						gate: request.id,
						shell: request.shell,
						command: request.command,
						environment: request.environment
					}),
					workingDirectory: request.cwd,
					filesystem: {
						readwritePaths: request.readwritePaths,
						readonlyPaths: request.readonlyPaths,
						deniedPaths: request.deniedPaths
					},
					network: networkPolicy(
						request.network === 'denied' ? 'ip-denied' : request.network
					),
					environment: { PATH: SYSTEM_PATH },
					inheritDefaultEnvironment: false,
					ui: { disable: true }
				},
				{ telemetry: { enabled: false } }
			);

			const stdout = this.#target.standardOutput;
			const stderr = this.#target.standardError;
			const stdin = this.#target.standardInput;

			if (!stdout || !stderr || !stdin) {
				throw new MissingStandardStreamsError();
			}

			this.#input = stdin;

			const output = Promise.all([
				pipeline(stdout, createWriteStream('', { fd: 4 })),
				pipeline(stderr, createWriteStream('', { fd: 5 }))
			]);

			void output.catch(() => {
				this.#stop();
			});

			if (isOffline) {
				observer = new ExitObserver(this.#target.id);
				await observer.ready();
			}

			await this.#send({
				version: 1,
				kind: 'started',
				id: request.id,
				pid: this.#target.id
			});

			if (this.#isCancelled) {
				this.#stop();
			}

			const result = await this.#target.wait();

			const status = await observer?.status();

			await output;

			if (this.#hasStopFailure) {
				throw new StopNotAcknowledgedError();
			}

			await this.#send({
				version: 1,
				kind: 'completed',
				id: request.id,
				exitCode: status ?? result.exitCode,
				...(status !== undefined && status < 0 && { signalNumber: -status }),
				warnings: Math.min(64, this.#target.warnings.length)
			});
		} catch {
			this.#stop();

			try {
				await this.#send({ version: 1, kind: 'failed', id: request.id });
			} catch {
				process.exitCode = 1;
			}
		} finally {
			observer?.close();
			this.#target?.dispose();

			if (process.connected) {
				process.disconnect();
			}
		}
	}

	#abandon(): void {
		this.#stop();

		if (!(this.#job === undefined && process.connected)) {
			return;
		}

		process.exitCode = 1;
		process.disconnect();
	}

	#receive(message: unknown): void {
		if (!isParentMessage(message)) {
			this.#abandon();

			return;
		}

		if (message.kind === 'start') {
			if (this.#job !== undefined) {
				this.#stop();

				return;
			}

			this.#job = message;
			void this.#execute(message);

			return;
		}

		if (message.id !== this.#job?.id) {
			this.#abandon();

			return;
		}

		if (message.kind === 'cancel') {
			this.#stop();

			return;
		}

		if (this.#isCancelled || this.#isReleased) {
			return;
		}

		this.#isReleased = true;

		if (this.#input === undefined) {
			return;
		}

		this.#input.write(`${message.id}\n`);
		void pipeline(process.stdin, this.#input).catch((error: unknown) => {
			if (!(
				error instanceof Error &&
				'code' in error &&
				(error.code === 'EPIPE' || error.code === 'ERR_STREAM_PREMATURE_CLOSE')
			)) {
				this.#stop();
			}
		});
	}

	start(): void {
		process.on('message', (message: unknown) => {
			this.#receive(message);
		});
		process.on('disconnect', () => {
			this.#stop();
		});
		process.on('SIGTERM', () => {
			this.#stop();
		});
		void this.#send({ version: 1, kind: 'ready' }).catch(() => {
			this.#stop();
		});
	}
}

new MxcSupervisor().start();
