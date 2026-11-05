import { expect, it } from 'vitest';

import { ProcessTableUnavailableError } from '../errors.js';

import type { SignalProbe } from './process-groups.js';
import { ProcessGroups } from './process-groups.js';

function groups(
	snapshot: string | Error,
	probes: Readonly<Record<number, ReturnType<SignalProbe>>> = {}
) {
	const reads: number[] = [];
	const instance = new ProcessGroups(
		(timeoutMs) => {
			reads.push(timeoutMs);

			return snapshot instanceof Error
				? Promise.reject(snapshot)
				: Promise.resolve(snapshot);
		},
		(target) => probes[target] ?? 'unknown'
	);

	return { instance, reads };
}

it('requires a live group leader before target release', async () => {
	const { instance } = groups('42 42 S\n43 42 S\n43 42 Z\n');

	expect({
		leader: await instance.isLeader(42),
		member: await instance.isLeader(43)
	}).toStrictEqual({ leader: true, member: false });
});

it.each([
	{ snapshot: '42 42 Z\n', expected: true },
	{ snapshot: '43 42 S\n', expected: false },
	{ snapshot: '43 43 S\n', expected: true },
	{ snapshot: 'malformed', expected: undefined }
])(
	'checks complete snapshots conservatively: $snapshot',
	async ({ snapshot, expected }) => {
		const { instance } = groups(snapshot);

		expect(await instance.isEmpty(42)).toBe(expected);
	}
);

it('reports observer failure as unknown rather than as an empty group', async () => {
	const { instance } = groups(new ProcessTableUnavailableError(['/bin/ps']));

	expect({
		isEmpty: await instance.isEmpty(42),
		isLeader: await instance.isLeader(42)
	}).toStrictEqual({ isEmpty: undefined, isLeader: undefined });
});

it.each([
	{
		name: 'a live leader',
		probes: { 42: 'present', [-42]: 'present' },
		expected: { isLeader: true, reads: [] }
	},
	{
		name: 'a target without its own group',
		probes: { 42: 'present', [-42]: 'absent' },
		expected: { isLeader: false, reads: [] }
	},
	{
		name: 'an exited target whose group remains',
		probes: { 42: 'absent', [-42]: 'present' },
		expected: { isLeader: false, reads: [] }
	},
	{
		name: 'a target that cannot be signalled',
		probes: { 42: 'unknown', [-42]: 'present' },
		expected: { isLeader: true, reads: [1000] }
	}
] as const)(
	'checks leadership with signals before reading the process table: $name',
	async ({ probes, expected }) => {
		const { instance, reads } = groups('42 42 S\n', probes);

		expect({ isLeader: await instance.isLeader(42), reads }).toStrictEqual(
			expected
		);
	}
);

it.each([
	{
		name: 'a group without members',
		probe: 'absent',
		expected: { isEmpty: true, reads: [] }
	},
	{
		name: 'a group with only a zombie',
		probe: 'present',
		expected: { isEmpty: true, reads: [1000] }
	}
] as const)(
	'checks group emptiness with a signal before reading the process table: $name',
	async ({ probe, expected }) => {
		const { instance, reads } = groups('42 42 Z\n', { [-42]: probe });

		expect({ isEmpty: await instance.isEmpty(42), reads }).toStrictEqual(
			expected
		);
	}
);
