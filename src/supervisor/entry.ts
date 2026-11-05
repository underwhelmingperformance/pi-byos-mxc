import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { MxcProcess } from '@microsoft/mxc-sdk/v1';
import { spawn } from '@microsoft/mxc-sdk/v1';

import { networkPolicy } from '../policy.js';
import { transportCommand } from '../shell.js';

import type { ChildMessage, StartMessage } from './protocol.js';
import { parentMessage } from './protocol.js';

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
				reject(new Error('The MXC supervisor control channel is closed.'));

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
		try {
			const remaining = request.deadline - Date.now();
			const timeoutMs = Math.max(1, Math.min(4_294_967_295, remaining));

			this.#target = await spawn(
				{
					containment: { type: request.backend },
					command: transportCommand({
						gate: request.id,
						shell: request.shell,
						command: request.command,
						environment: request.environment
					}),
					workingDirectory: request.cwd,
					filesystem: {
						readwritePaths: [request.workspace, request.scratch],
						readonlyPaths: request.readonlyPaths
					},
					network: networkPolicy(request.network),
					environment: { PATH: '/bin:/usr/bin:/usr/sbin:/sbin' },
					inheritDefaultEnvironment: false,
					timeoutMs,
					ui: { disable: true }
				},
				{ telemetry: { enabled: false } }
			);

			const stdout = this.#target.standardOutput;
			const stderr = this.#target.standardError;
			const stdin = this.#target.standardInput;

			if (!stdout || !stderr || !stdin) {
				throw new Error('MXC did not expose the required standard streams.');
			}

			this.#input = stdin;

			const output = Promise.all([
				pipeline(stdout, createWriteStream('', { fd: 4 })),
				pipeline(stderr, createWriteStream('', { fd: 5 }))
			]);

			void output.catch(() => {
				this.#stop();
			});
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

			await output;

			if (this.#hasStopFailure) {
				throw new Error('MXC could not acknowledge the stop request.');
			}

			await this.#send({
				version: 1,
				kind: 'completed',
				id: request.id,
				...result,
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
			this.#target?.dispose();

			if (process.connected) {
				process.disconnect();
			}
		}
	}

	#receive(message: unknown): void {
		if (!parentMessage.Check(message)) {
			this.#stop();

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
			this.#stop();

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
		this.#input?.end(`${message.id}\n`);
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
