import { createWriteStream } from 'node:fs';

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

const stdout = createWriteStream('', { fd: 4 });
const stderr = createWriteStream('', { fd: 5 });
const state = { id: '', mode: '' };

function finish(exitCode: number, isTimedOut = false): void {
	stdout.end();
	stderr.end();
	process.send?.(
		{
			version: 1,
			kind: 'completed',
			id: state.id,
			exitCode,
			timedOut: isTimedOut,
			warnings: 0
		},
		() => {
			if (state.mode === 'completed-then-failed') {
				process.send?.({ version: 1, kind: 'failed', id: state.id }, () => {
					process.disconnect();
				});

				return;
			}

			if (state.mode === 'duplicate-completion') {
				process.send?.(
					{
						version: 1,
						kind: 'completed',
						id: state.id,
						exitCode,
						timedOut: isTimedOut,
						warnings: 0
					},
					() => {
						process.disconnect();
					}
				);

				return;
			}

			process.disconnect();
		}
	);
}

process.on('message', (message: unknown) => {
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
			process.send?.({ version: 1, kind: 'invalid' });

			return;
		}

		process.send?.({ version: 1, kind: 'started', id: state.id, pid: 42 });

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
		process.emitWarning('Private native cleanup details.', {
			code: 'MXC_NATIVE_CLEANUP_FAILED'
		});
		stdout.end();
		stderr.end();
		process.send?.({ version: 1, kind: 'failed', id: state.id }, () => {
			process.disconnect();
		});

		return;
	}

	if (state.mode === 'wait') {
		stdout.write('ready');

		return;
	}

	stdout.write('{"kind":"completed"}\n');
	stderr.write('target stderr');
	finish(state.mode === 'unavailable' ? -1 : 7, state.mode === 'timeout');
});
process.send?.({ version: 1, kind: 'ready' });
