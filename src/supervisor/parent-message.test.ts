import { expect, it } from 'vitest';

import { isParentMessage } from './parent-message.js';
import { parentMessage } from './protocol.js';

const id = '00000000-0000-4000-8000-000000000001';
const start = {
	version: 1,
	kind: 'start',
	id,
	backend: 'seatbelt',
	network: 'ip-denied',
	command: 'printf ok',
	shell: '/bin/sh',
	cwd: '/workspace',
	readwritePaths: ['/workspace'],
	environment: { PATH: '/bin', '-S': 'option' },
	readonlyPaths: ['/bin/sh'],
	deniedPaths: []
};

const messages: readonly { readonly name: string; readonly value: unknown }[] =
	[
		{ name: 'start', value: start },
		{ name: 'release', value: { version: 1, kind: 'release', id } },
		{ name: 'cancel', value: { version: 1, kind: 'cancel', id } },
		{ name: 'extra property', value: { ...start, extra: true } },
		{ name: 'string', value: 'start' },
		{ name: 'array', value: [start] },
		{ name: 'wrong version', value: { ...start, version: 2 } },
		{ name: 'unknown kind', value: { version: 1, kind: 'stop', id } },
		{
			name: 'uppercase id',
			value: {
				version: 1,
				kind: 'cancel',
				id: 'ABCDEF00-0000-4000-8000-000000000001'
			}
		},
		{ name: 'short id', value: { version: 1, kind: 'cancel', id: 'abc' } },
		{ name: 'unknown backend', value: { ...start, backend: 'lxc' } },
		{ name: 'unknown network', value: { ...start, network: 'open' } },
		{ name: 'command with NUL', value: { ...start, command: 'a\0b' } },
		{ name: 'relative shell', value: { ...start, shell: 'sh' } },
		{ name: 'relative cwd', value: { ...start, cwd: 'workspace' } },
		{ name: 'path with NUL', value: { ...start, readonlyPaths: ['/a\0'] } },
		{ name: 'relative grant', value: { ...start, readwritePaths: ['tmp'] } },
		{ name: 'grant list', value: { ...start, deniedPaths: '/run' } },
		{
			name: 'missing denied paths',
			value: { ...start, deniedPaths: undefined }
		},
		{
			name: 'environment key with =',
			value: { ...start, environment: { 'A=B': 'x' } }
		},
		{
			name: 'empty environment key',
			value: { ...start, environment: { '': 'x' } }
		},
		{ name: 'environment value', value: { ...start, environment: { A: 1 } } },
		{ name: 'environment list', value: { ...start, environment: ['A'] } },
		{ name: 'number command', value: { ...start, command: 1 } }
	];

it('accepts exactly the parent messages that the protocol schema accepts', () => {
	expect(
		messages.map(({ name, value }) => [name, isParentMessage(value)])
	).toStrictEqual(
		messages.map(({ name, value }) => [name, parentMessage.Check(value)])
	);
	expect(
		messages
			.filter(({ value }) => isParentMessage(value))
			.map(({ name }) => name)
	).toStrictEqual(['start', 'release', 'cancel', 'extra property']);
});
