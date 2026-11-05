import { createWriteStream } from 'node:fs';

// Node runs this file directly with type stripping, which does not map `.js`
// imports to TypeScript sources.
import { superviseFixture } from './supervisor-script.ts';

superviseFixture({
	send(message, callback) {
		process.send?.(message, () => {
			callback?.();
		});
	},
	onMessage(listener) {
		process.on('message', listener);
	},
	warn(message) {
		process.emitWarning(message, { code: 'MXC_NATIVE_CLEANUP_FAILED' });
	},
	disconnect() {
		process.disconnect();
	},
	stdout: createWriteStream('', { fd: 4 }),
	stderr: createWriteStream('', { fd: 5 })
});
