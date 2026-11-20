import { execFile } from 'node:child_process';
import path from 'node:path';

import type { SandboxOpenContext } from 'pi-bring-your-own-sandbox/api';

export async function copyWorkspace(
	entry: string,
	workspace: string,
	allocation: string,
	context: SandboxOpenContext
): Promise<string> {
	const helper = path.resolve(path.dirname(entry), '../native/snapshot');
	const remaining = Math.floor(context.remainingMs());
	const timeout = Math.min(2_147_483_647, Math.max(1, remaining));

	await new Promise<void>((resolve, reject) => {
		let failure: Error | undefined;
		const child = execFile(
			helper,
			[workspace, allocation],
			{
				cwd: '/',
				env: {},
				signal: context.signal,
				timeout,
				killSignal: 'SIGKILL'
			},
			(error) => {
				failure = error ?? undefined;
			}
		);

		// An abort can invoke the callback while the helper still has the copy open.
		child.once('close', () => {
			if (failure) {
				reject(failure);

				return;
			}

			resolve();
		});
	});

	return path.join(allocation, 'workspace');
}
