import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const snapshotTimeoutMs = 5000;

export async function readProcessTable(): Promise<string> {
	try {
		const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
			timeout: snapshotTimeoutMs,
			maxBuffer: 2_097_152
		});

		return stdout;
	} catch (error) {
		if (
			error instanceof Error &&
			'killed' in error &&
			error.killed === true &&
			'signal' in error &&
			typeof error.signal === 'string'
		) {
			throw new Error(
				`The ps probe was killed by ${error.signal} with a ${String(snapshotTimeoutMs)} ms timeout.`,
				{ cause: error }
			);
		}

		throw error;
	}
}
