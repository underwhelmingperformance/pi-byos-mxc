import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';

import { ControlChannelClosedError } from '../errors.js';
import type { SupervisorProcess } from '../supervisor/client.js';
import type { ParentMessage } from '../supervisor/protocol.js';

import type { SupervisorPort } from './supervisor-script.js';
import { superviseFixture } from './supervisor-script.js';

function later(callback: () => void): void {
	setImmediate(callback);
}

interface Listeners {
	readonly error: ((error: Error) => void)[];
	readonly close: ((code?: number | null) => void)[];
	readonly message: ((message: unknown) => void)[];
}

/**
An in-memory supervisor child process. Messages cross the fake IPC channel on
a later event-loop turn, as they do between real processes, and `close` follows
the end of both output streams.
*/
class FakeSupervisorProcess implements SupervisorProcess {
	readonly #stdout = new PassThrough();
	readonly #stderr = new PassThrough();
	readonly #listeners: Listeners = { error: [], close: [], message: [] };
	readonly #received: ((message: unknown) => void)[] = [];
	#isClosing = false;
	readonly pid = 4242;
	connected = true;
	readonly stdio = [
		undefined,
		undefined,
		undefined,
		undefined,
		this.#stdout,
		this.#stderr
	] as const;

	constructor(script: (port: SupervisorPort) => void) {
		later(() => {
			script({
				send: (message, callback) => {
					later(() => {
						if (this.connected) {
							for (const listener of this.#listeners.message) {
								listener(structuredClone(message));
							}
						}

						callback?.();
					});
				},
				onMessage: (listener) => {
					this.#received.push(listener);
				},
				warn() {
					return;
				},
				disconnect: () => {
					this.exit(0);
				},
				stdout: this.#stdout,
				stderr: this.#stderr
			});
		});
	}

	#close(code?: number): void {
		if (this.#isClosing) {
			return;
		}

		this.#isClosing = true;
		this.connected = false;
		this.#stdout.end();
		this.#stderr.end();
		void Promise.all([finished(this.#stdout), finished(this.#stderr)]).then(
			() => {
				for (const listener of this.#listeners.close) {
					listener(code);
				}
			}
		);
	}

	on(event: 'error', listener: (error: Error) => void): this;
	on(event: 'close', listener: (code?: number | null) => void): this;
	on(event: 'message', listener: (message: unknown) => void): this;
	on(
		event: keyof Listeners,
		listener: Listeners[keyof Listeners][number]
	): this {
		(this.#listeners[event] as (typeof listener)[]).push(listener);

		return this;
	}

	send(
		message: ParentMessage,
		callback: (error?: Error | null) => void
	): boolean {
		if (!this.connected) {
			later(() => {
				callback(new ControlChannelClosedError());
			});

			return false;
		}

		later(() => {
			for (const listener of this.#received) {
				listener(structuredClone(message));
			}

			callback();
		});

		return true;
	}

	kill(): boolean {
		this.#close();

		return true;
	}

	exit(code: number): void {
		this.#close(code);
	}
}

/**
Returns a `spawn` replacement that starts an in-memory supervisor running
`script`, which defaults to the scenarios in `superviseFixture`.
*/
export function fakeSupervisor(
	script: (
		port: SupervisorPort,
		process: { exit(code: number): void }
	) => void = superviseFixture
): () => SupervisorProcess {
	return () => {
		const child: FakeSupervisorProcess = new FakeSupervisorProcess((port) => {
			script(port, child);
		});

		return child;
	};
}
