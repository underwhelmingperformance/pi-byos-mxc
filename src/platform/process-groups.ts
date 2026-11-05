import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

import { ProcessTableUnavailableError } from '../errors.js';

interface ProcessIdentity {
	readonly id: number;
	readonly group: number;
	readonly zombie: boolean;
}

type SnapshotReader = (timeoutMs: number) => Promise<string>;

/**
Sends signal 0 to a process, or to a process group when `target` is negative,
and reports whether the target exists.
*/
export type SignalProbe = (target: number) => 'present' | 'absent' | 'unknown';

const signalProbe: SignalProbe = (target) => {
	try {
		process.kill(target, 0);

		return 'present';
	} catch (error) {
		return error instanceof Error && 'code' in error && error.code === 'ESRCH'
			? 'absent'
			: 'unknown';
	}
};

const execute = promisify(execFile);
const SNAPSHOT_TIMEOUT_MS = 1000;

export const PS_LOCATIONS = Object.freeze([
	'/bin/ps',
	'/usr/bin/ps',
	'/run/current-system/sw/bin/ps'
]);

async function findExecutable(candidates: readonly string[]): Promise<string> {
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);

			return candidate;
		} catch {
			continue;
		}
	}

	throw new ProcessTableUnavailableError(candidates);
}

export function snapshotReader(
	candidates: readonly string[] = PS_LOCATIONS
): SnapshotReader {
	let executable: Promise<string> | undefined;

	return async (timeoutMs) => {
		executable ??= findExecutable(candidates);

		const result = await execute(
			await executable,
			['-axo', 'pid=,pgid=,stat='],
			{
				timeout: timeoutMs,
				maxBuffer: 2_097_152,
				env: { PATH: '/bin:/usr/bin' }
			}
		);

		return result.stdout;
	};
}

function parseSnapshot(text: string): ProcessIdentity[] | undefined {
	const processes: ProcessIdentity[] = [];

	for (const line of text.trim().split('\n')) {
		const fields = line.trim().split(/\s+/u);
		const id = Number(fields[0]);
		const group = Number(fields[1]);
		const status = fields[2];

		if (
			status === undefined ||
			fields.length !== 3 ||
			id <= 0 ||
			group < 0 ||
			!Number.isSafeInteger(id) ||
			!Number.isSafeInteger(group)
		) {
			return;
		}

		processes.push({ id, group, zombie: status.startsWith('Z') });
	}

	return processes;
}

/**
Checks process groups with signal 0 and falls back to a `ps` snapshot when the
signals cannot decide. A process ID is not reused while a process group with
that ID exists, so a target with its own existing group is that group's leader.
*/
export class ProcessGroups {
	readonly #read: SnapshotReader;
	readonly #probe: SignalProbe;

	constructor(
		read: SnapshotReader = snapshotReader(),
		probe: SignalProbe = signalProbe
	) {
		this.#read = read;
		this.#probe = probe;
	}

	async #snapshot(): Promise<ProcessIdentity[] | undefined> {
		try {
			const snapshot = await this.#read(SNAPSHOT_TIMEOUT_MS);

			return parseSnapshot(snapshot);
		} catch {
			return;
		}
	}

	/**
	Call this only while the target is blocked at its release gate, so that it
	cannot have moved to another group. Resolves to `undefined` when the process
	table cannot be read.
	*/
	async isLeader(id: number): Promise<boolean | undefined> {
		const own = this.#probe(id);
		const group = this.#probe(-id);

		if (own === 'absent' || group === 'absent') {
			return false;
		}

		// A zombie target also passes, but it cannot run anything after release.
		if (own === 'present' && group === 'present') {
			return true;
		}

		const snapshot = await this.#snapshot();

		return snapshot?.some(
			(process) => process.id === id && process.group === id && !process.zombie
		);
	}

	/**
	Resolves to `undefined` when the process table cannot be read.
	*/
	async isEmpty(group: number): Promise<boolean | undefined> {
		if (this.#probe(-group) === 'absent') {
			return true;
		}

		// Zombie members answer signals, so only the snapshot can tell whether
		// every remaining member has stopped.
		const snapshot = await this.#snapshot();

		return snapshot?.every(
			(process) => process.group !== group || process.zombie
		);
	}
}
