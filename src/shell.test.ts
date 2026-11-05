import { Type } from 'typebox';
import { Decode } from 'typebox/value';
import { expect, it } from 'vitest';

import { targetEnvironment, transportCommand } from './shell.js';

it('applies overrides and deletions without changing provider defaults', () => {
	const defaults = { PATH: '/bin', HOME: '/workspace', REMOVE: 'present' };
	const overrides = Decode(
		Type.Object({ REMOVE: Type.Null(), VALUE: Type.String() }),
		JSON.parse('{"REMOVE":null,"VALUE":"literal $HOME"}')
	);

	expect({
		result: targetEnvironment(defaults, overrides),
		defaults
	}).toStrictEqual({
		result: { PATH: '/bin', HOME: '/workspace', VALUE: 'literal $HOME' },
		defaults: { PATH: '/bin', HOME: '/workspace', REMOVE: 'present' }
	});
});

it('separates the gate, target environment and literal shell script', () => {
	expect(
		transportCommand({
			gate: 'job-token',
			shell: '/bin/bash',
			command: 'printf "$HOME"',
			environment: { VALUE: "a'b\n$HOME" }
		})
	).toBe(
		"IFS= read -r token || exit 125; [ \"$token\" = 'job-token' ] || exit 125; exec /usr/bin/env -i -- 'VALUE=a'\\''b\n$HOME' '/bin/bash' -c 'printf \"$HOME\"'"
	);
});
