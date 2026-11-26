import { execFile } from 'node:child_process';
import path from 'node:path';

import type { SandboxOpenContext } from 'pi-bring-your-own-sandbox/api';

export class SnapshotRefusalError extends Error {
	override readonly name = 'SnapshotRefusalError';
}

const refusalStatus = {
	entryLimit: 2,
	depthLimit: 3,
	byteLimit: 4,
	absoluteLink: 5,
	unresolvedLink: 6,
	crossesMount: 7,
	restrictedFlags: 8,
	specialFile: 9,
	hardLink: 10,
	sourceChanged: 11,
	pathLimit: 12,
	cloneUnavailable: 13
} as const;

type SnapshotRefusalStatus = (typeof refusalStatus)[keyof typeof refusalStatus];

const refusalMessages: Readonly<Record<SnapshotRefusalStatus, string>> = {
	[refusalStatus.entryLimit]:
		'The workspace exceeds 100,000 entries. Remove generated files before copying.',
	[refusalStatus.depthLimit]:
		'The workspace exceeds 128 levels of nesting. Move or remove deeply nested entries before copying.',
	[refusalStatus.byteLimit]:
		'The workspace exceeds 512 MiB of regular file data. Move or remove large files before copying.',
	[refusalStatus.absoluteLink]:
		'The workspace has an absolute symbolic link. Replace it with a relative link that resolves inside the copy, or remove it.',
	[refusalStatus.unresolvedLink]:
		'A symbolic link does not resolve inside the copy. Fix the link or remove it before copying.',
	[refusalStatus.crossesMount]:
		'The workspace crosses a mount. Unmount it or copy a workspace on a single filesystem.',
	[refusalStatus.restrictedFlags]:
		'The workspace has an immutable or append-only entry. Remove the flags or move the entry before copying.',
	[refusalStatus.specialFile]:
		'The workspace contains a special file. Remove sockets, FIFOs and devices before copying.',
	[refusalStatus.hardLink]:
		'The workspace contains a multiply linked regular file. Replace hard links with independent files before copying.',
	[refusalStatus.sourceChanged]:
		'The workspace changed while MXC was copying it. Stop the processes that modify it and retry.',
	[refusalStatus.pathLimit]:
		'A path in the copy exceeds the system path length limit. Shorten the path before copying.',
	[refusalStatus.cloneUnavailable]:
		'The copy requires file cloning on the same filesystem. Move the workspace to a filesystem that supports cloning and contains the temporary directory.'
};

function isSnapshotRefusal(status: unknown): status is SnapshotRefusalStatus {
	return typeof status === 'number' && Object.hasOwn(refusalMessages, status);
}

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
				const message = isSnapshotRefusal(error?.code)
					? refusalMessages[error.code]
					: undefined;

				failure =
					message === undefined
						? (error ?? undefined)
						: new SnapshotRefusalError(message);
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
