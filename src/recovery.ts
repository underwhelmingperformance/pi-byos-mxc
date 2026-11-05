import { randomUUID } from 'node:crypto';
import {
	mkdir,
	realpath,
	rename,
	rm,
	unlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	RecoveryDescriptor,
	SandboxOpenContext
} from 'pi-bring-your-own-sandbox/api';
import {
	SandboxCleanupError,
	SandboxSessionClosingError,
	SandboxStartupError
} from 'pi-bring-your-own-sandbox/api';

import { assertDisjointPaths } from './paths.js';
import type { JobAllocation } from './supervisor/client.js';

export class RecoveryStore {
	static async open(
		workspace: string,
		context: SandboxOpenContext
	): Promise<RecoveryStore> {
		const base = await realpath(tmpdir());
		const canonicalWorkspace = await realpath(workspace);
		const id = randomUUID();
		const root = path.join(base, `pi-byos-mxc-${id}`);

		assertDisjointPaths(canonicalWorkspace, [root]);

		const store = new RecoveryStore(root, id);
		let hasCreated = false;

		context.reportRecovery(store.recovery);

		try {
			if (context.signal.aborted || context.deadline <= Date.now()) {
				throw new Error('MXC opening was cancelled before allocation.');
			}

			await mkdir(root, { mode: 0o700 });
			hasCreated = true;
			await mkdir(store.scratch, { mode: 0o700 });

			return store;
		} catch (error) {
			if (hasCreated) {
				try {
					await rm(root, { recursive: true, force: true });
				} catch (cleanupError) {
					throw new SandboxCleanupError(
						{ operation: 'open', providerId: 'mxc', recovery: store.recovery },
						{ cause: cleanupError }
					);
				}
			}

			throw new SandboxStartupError(
				{ operation: 'open', providerId: 'mxc' },
				{ cause: error }
			);
		}
	}

	readonly #jobs = new Set<string>();
	#isClosing = false;
	#disposal: Promise<void> | undefined;
	readonly root: string;
	readonly scratch: string;
	readonly recovery: RecoveryDescriptor;

	private constructor(root: string, id: string) {
		this.root = root;
		this.scratch = path.join(root, 'scratch');
		this.recovery = Object.freeze({
			kind: 'allocation',
			id,
			lease:
				'No automatic expiry. Manual recovery is required after an unconfirmed cleanup or hard host crash.',
			instructions: `Inspect provider job records in ${root}. Match each job ID to the supervisor command line and verify current process and group identities before any action. Records identify supervisors and direct targets, not every descendant. An unreported target may still be waiting at its job-ID stdin gate. Do not signal a PID solely because a record lists it. Remove only this directory after the recorded supervisors, supervised groups and provider-owned allocations have been released. Descendants outside those groups may still modify permitted workspace files; removing this directory does not revoke their access.`
		});
	}

	#jobPath(id: string): string {
		if (!/^[a-z\d-]+$/u.test(id)) {
			throw new TypeError(
				'Recovery job IDs must contain only lowercase letters, digits and hyphens.'
			);
		}

		return path.join(this.root, `${id}.json`);
	}

	async #dispose(): Promise<void> {
		if (this.#jobs.size > 0) {
			throw new SandboxCleanupError({
				operation: 'dispose',
				providerId: 'mxc',
				recovery: this.recovery
			});
		}

		await rm(this.root, { recursive: true, force: true });
	}

	async begin(id: string): Promise<void> {
		if (this.#isClosing) {
			throw new SandboxSessionClosingError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		await writeFile(this.#jobPath(id), JSON.stringify({ id }), {
			flag: 'wx',
			mode: 0o600
		});
		this.#jobs.add(id);
	}

	async record(allocation: JobAllocation): Promise<void> {
		if (!this.#jobs.has(allocation.id)) {
			throw new Error(
				'A recovery allocation must be registered before its identity is updated.'
			);
		}

		const destination = this.#jobPath(allocation.id);
		const temporary = `${destination}.tmp`;
		const record = {
			id: allocation.id,
			supervisorPid: allocation.supervisorPid,
			...(allocation.targetPid !== undefined && {
				targetPid: allocation.targetPid
			})
		};

		await writeFile(temporary, JSON.stringify(record), {
			flag: 'wx',
			mode: 0o600
		});
		await rename(temporary, destination);
	}

	async confirmReleased(id: string): Promise<void> {
		await unlink(this.#jobPath(id));
		this.#jobs.delete(id);
	}

	dispose(): Promise<void> {
		this.#isClosing = true;
		this.#disposal ??= this.#dispose();

		return this.#disposal;
	}
}
