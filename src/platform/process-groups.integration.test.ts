import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { expect, it } from 'vitest';

import { ProcessGroups, snapshotReader } from './process-groups.js';

it('uses the first available ps from its trusted locations', async () => {
	const groups = new ProcessGroups(
		snapshotReader(['/nonexistent/ps', '/bin/ps', '/usr/bin/ps'])
	);

	expect(await groups.isEmpty(2 ** 30)).toBe(true);
});

it('reports a host without ps in a trusted location as unknown', async () => {
	const groups = new ProcessGroups(snapshotReader(['/nonexistent/ps']));

	expect(await groups.isEmpty(1)).toBeUndefined();
});

it('recognises a real group leader and its empty group without ps', async () => {
	const groups = new ProcessGroups(() => expect.unreachable());
	const child = spawn('/bin/sleep', ['30'], {
		detached: true,
		stdio: 'ignore'
	});
	const exited = once(child, 'exit');
	const id = child.pid ?? 0;
	const running = await groups.isLeader(id);

	child.kill('SIGKILL');
	await exited;

	expect({ running, empty: await groups.isEmpty(id) }).toStrictEqual({
		running: true,
		empty: true
	});
});
