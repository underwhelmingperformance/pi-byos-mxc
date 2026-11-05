import { spawnSync } from 'node:child_process';

import { expect, it } from 'vitest';

import { transportCommand } from './shell.js';

it('passes an environment key that starts with a dash as a variable', () => {
	const result = spawnSync(
		'/bin/sh',
		[
			'-c',
			transportCommand({
				gate: 'job-token',
				shell: '/bin/sh',
				command: 'printf %s "$VALUE"',
				environment: { '-S': 'option', VALUE: 'value' }
			})
		],
		{ input: 'job-token\n', encoding: 'utf8' }
	);

	expect({
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr
	}).toStrictEqual({ status: 0, stdout: 'value', stderr: '' });
});
