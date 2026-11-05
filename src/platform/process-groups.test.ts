import { expect, it } from 'vitest';

import { ProcessGroups } from './process-groups.js';

it('requires a live group leader before target release', async () => {
	const groups = new ProcessGroups(() => Promise.resolve('42 42 S\n43 42 S\n'));

	expect(await groups.isLeader(42, Date.now() + 1000)).toBe(true);
	expect(await groups.isLeader(43, Date.now() + 1000)).toBe(false);
});

it.each([
	{ snapshot: '42 42 Z\n', expected: true },
	{ snapshot: '43 42 S\n', expected: false },
	{ snapshot: '43 43 S\n', expected: true },
	{ snapshot: 'malformed', expected: false }
])(
	'checks complete snapshots conservatively: $snapshot',
	async ({ snapshot, expected }) => {
		const groups = new ProcessGroups(() => Promise.resolve(snapshot));

		expect(await groups.isEmpty(42, Date.now() + 1000)).toBe(expected);
	}
);

it('does not mistake observer failure for an empty group', async () => {
	const groups = new ProcessGroups(() =>
		Promise.reject(new Error('ps failed'))
	);

	expect(await groups.isEmpty(42, Date.now() + 1000)).toBe(false);
});
