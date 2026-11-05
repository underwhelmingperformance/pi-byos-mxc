import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

interface ProcessIdentity {
	readonly id: number;
	readonly group: number;
	readonly zombie: boolean;
}

type SnapshotReader = (timeoutMs: number) => Promise<string>;

const execute = promisify(execFile);

async function readSnapshot(timeoutMs: number): Promise<string> {
	const result = await execute('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
		timeout: timeoutMs,
		maxBuffer: 2_097_152,
		env: { PATH: '/bin:/usr/bin' }
	});

	return result.stdout;
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

export class ProcessGroups {
	readonly #read: SnapshotReader;

	constructor(read: SnapshotReader = readSnapshot) {
		this.#read = read;
	}

	async #snapshot(deadline: number): Promise<ProcessIdentity[] | undefined> {
		const remaining = deadline - Date.now();

		if (remaining <= 0) {
			return;
		}

		try {
			const timeoutMs = Math.max(1, Math.min(1000, remaining));
			const snapshot = await this.#read(timeoutMs);

			return parseSnapshot(snapshot);
		} catch {
			return;
		}
	}

	async isLeader(id: number, deadline: number): Promise<boolean> {
		const snapshot = await this.#snapshot(deadline);

		return (
			snapshot?.some(
				(process) =>
					process.id === id && process.group === id && !process.zombie
			) === true
		);
	}

	async isEmpty(group: number, deadline: number): Promise<boolean> {
		const snapshot = await this.#snapshot(deadline);

		return (
			snapshot?.every(
				(process) => process.group !== group || process.zombie
			) === true
		);
	}
}
