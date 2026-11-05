import type { Writable } from 'node:stream';

import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

const parentSchema = Type.Union([
	Type.Object({
		version: Type.Literal(1),
		kind: Type.Literal('start'),
		id: Type.String(),
		command: Type.String()
	}),
	Type.Object({
		version: Type.Literal(1),
		kind: Type.Enum(['cancel', 'release']),
		id: Type.String()
	})
]);
const messageSchema = Compile(parentSchema);

/**
The control channel and output streams of a fake supervisor. The process
fixture connects them to IPC and file descriptors 4 and 5; unit tests connect
them to an in-memory child process.
*/
export interface SupervisorPort {
	send(message: unknown, callback?: () => void): void;
	onMessage(listener: (message: unknown) => void): void;
	warn(message: string): void;
	disconnect(): void;
	readonly stdout: Writable;
	readonly stderr: Writable;
}

/**
Runs a fake supervisor whose behaviour depends on the start message's command:
`normal` and `unavailable` complete after release, `wait` writes `ready` and
completes on cancellation, `hang` and `fault-hang` ignore cancellation, and the
remaining modes produce protocol or cleanup failures.
*/
export function superviseFixture(port: SupervisorPort): void {
	const state = { id: '', mode: '' };

	function finish(exitCode: number): void {
		const completion = {
			version: 1,
			kind: 'completed',
			id: state.id,
			exitCode,
			warnings: 0
		};

		port.stdout.end();
		port.stderr.end();
		port.send(completion, () => {
			if (state.mode === 'completed-then-failed') {
				port.send({ version: 1, kind: 'failed', id: state.id }, () => {
					port.disconnect();
				});

				return;
			}

			if (state.mode === 'duplicate-completion') {
				port.send(completion, () => {
					port.disconnect();
				});

				return;
			}

			port.disconnect();
		});
	}

	port.onMessage((message) => {
		if (!messageSchema.Check(message)) {
			return;
		}

		if (message.kind === 'start') {
			state.id = message.id;
			state.mode = message.command;

			if (state.mode === 'early-completion') {
				finish(0);

				return;
			}

			if (state.mode === 'malformed') {
				port.send({ version: 1, kind: 'invalid' });

				return;
			}

			port.send({ version: 1, kind: 'started', id: state.id, pid: 42 });

			return;
		}

		if (message.kind === 'cancel') {
			if (state.mode === 'hang' || state.mode === 'fault-hang') {
				return;
			}

			finish(-1);

			return;
		}

		if (state.mode === 'cleanup-failure') {
			port.warn('Private native cleanup details.');
			port.stdout.end();
			port.stderr.end();
			port.send({ version: 1, kind: 'failed', id: state.id }, () => {
				port.disconnect();
			});

			return;
		}

		if (state.mode === 'wait') {
			port.stdout.write('ready');

			return;
		}

		if (state.mode === 'sleep') {
			return;
		}

		port.stdout.write('{"kind":"completed"}\n');
		port.stderr.write('target stderr');
		finish(state.mode === 'unavailable' ? -1 : 7);
	});
	port.send({ version: 1, kind: 'ready' });
}
