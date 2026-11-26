import path from 'node:path';

import type {
	RecoveryDescriptor,
	SandboxOpenContext
} from 'pi-bring-your-own-sandbox/provider';
import {
	SandboxCleanupError,
	SandboxSessionClosingError,
	SandboxStartupError
} from 'pi-bring-your-own-sandbox/provider';

import {
	AllocationCancelledError,
	InvalidJobIdError,
	UnregisteredJobError
} from './errors.js';
import type { Host, HostFileSystem } from './host.js';
import { assertDisjointPaths } from './paths.js';
import type { JobAllocation } from './supervisor/client.js';

export class RecoveryStore {
	static async open(
		workspace: string,
		context: SandboxOpenContext,
		host: Host
	): Promise<RecoveryStore> {
		const { fs } = host;
		const base = await fs.realpath(host.environment.temporaryDirectory);
		const canonicalWorkspace = await fs.realpath(workspace);
		const id = host.randomId();
		const root = path.join(base, `pi-byos-mxc-${id}`);

		assertDisjointPaths(canonicalWorkspace, [root]);

		const store = new RecoveryStore(fs, root, id);
		let hasCreated = false;

		context.reportRecovery(store.recovery);

		try {
			if (context.signal.aborted) {
				throw new AllocationCancelledError();
			}

			await fs.mkdir(root, { mode: 0o700 });
			hasCreated = true;
			await fs.mkdir(store.scratch, { mode: 0o700 });

			return store;
		} catch (error) {
			if (hasCreated) {
				try {
					await fs.rm(root, { recursive: true, force: true });
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

	readonly #fs: HostFileSystem;
	readonly #jobs = new Map<string, readonly string[]>();
	#isClosing = false;
	#disposal: Promise<void> | undefined;
	readonly id: string;
	readonly root: string;
	readonly scratch: string;
	readonly recovery: RecoveryDescriptor;

	private constructor(fs: HostFileSystem, root: string, id: string) {
		this.#fs = fs;
		this.id = id;
		this.root = root;
		this.scratch = path.join(root, 'scratch');
		this.recovery = Object.freeze({
			kind: 'allocation',
			id,
			lease:
				'No automatic expiry. Manual recovery is required after an unconfirmed cleanup or hard host crash.',
			instructions: `Inspect provider job records in ${root}. Match each job ID to the supervisor command line and verify current process and group identities before any action. Records identify supervisors and direct targets, not every descendant. An unreported target may still be waiting at its job-ID stdin gate. Do not signal a PID solely because a record lists it. Remove only this directory after the recorded supervisors, supervised groups and provider-owned allocations have been released. Descendants outside those groups may still modify permitted workspace files; removing this directory does not revoke their access. A record's placeholders are empty files that protect absent workspace paths; remove each one only after its job's processes have stopped, and only if it is still empty.`
		});
	}

	#jobPath(id: string): string {
		if (!/^[a-z\d-]+$/u.test(id)) {
			throw new InvalidJobIdError(id);
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

		await this.#fs.rm(this.root, { recursive: true, force: true });
	}

	/**
	Records a job before its supervisor starts. `placeholders` lists the empty
	files that the job created to protect absent workspace paths.
	*/
	async begin(id: string, placeholders: readonly string[] = []): Promise<void> {
		if (this.#isClosing) {
			throw new SandboxSessionClosingError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		await this.#fs.writeFile(
			this.#jobPath(id),
			JSON.stringify({
				id,
				...(placeholders.length > 0 && { placeholders })
			}),
			{ flag: 'wx', mode: 0o600 }
		);
		this.#jobs.set(id, placeholders);
	}

	async record(allocation: JobAllocation): Promise<void> {
		const placeholders = this.#jobs.get(allocation.id);

		if (placeholders === undefined) {
			throw new UnregisteredJobError(allocation.id);
		}

		const destination = this.#jobPath(allocation.id);
		const temporary = `${destination}.tmp`;
		const record = {
			id: allocation.id,
			supervisorPid: allocation.supervisorPid,
			...(allocation.targetPid !== undefined && {
				targetPid: allocation.targetPid
			}),
			...(placeholders.length > 0 && { placeholders })
		};

		await this.#fs.rm(temporary, { recursive: false, force: true });
		await this.#fs.writeFile(temporary, JSON.stringify(record), {
			flag: 'wx',
			mode: 0o600
		});
		await this.#fs.rename(temporary, destination);
	}

	async confirmReleased(id: string): Promise<void> {
		await this.#fs.unlink(this.#jobPath(id));
		this.#jobs.delete(id);
	}

	dispose(): Promise<void> {
		this.#isClosing = true;
		this.#disposal ??= this.#dispose();

		return this.#disposal;
	}
}
