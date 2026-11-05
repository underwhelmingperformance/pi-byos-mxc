import { describe, expect, it } from 'vitest';

import { MxcConfigError, validateConfig } from './config.js';

describe('MXC configuration', () => {
	it('uses explicit offline defaults without host environment inheritance', () => {
		expect(validateConfig({})).toStrictEqual({
			backend: 'auto',
			network: 'ip-denied',
			shells: { sh: '/bin/sh', bash: '/bin/bash' },
			readonlyPaths: [],
			environment: {}
		});
	});

	it('snapshots and freezes validated provider settings', () => {
		const input = {
			backend: 'seatbelt',
			network: 'open-egress',
			shells: { sh: '/bin/sh' },
			readonlyPaths: ['/opt/tools'],
			environment: { PATH: '/opt/tools/bin', VALUE: 'literal $HOME' }
		};
		const result = validateConfig(input);

		input.readonlyPaths.push('/private');
		input.environment.VALUE = 'changed';
		expect({
			result,
			frozen: [
				result,
				result.shells,
				result.readonlyPaths,
				result.environment
			].map((value) => Object.isFrozen(value))
		}).toStrictEqual({
			result: {
				backend: 'seatbelt',
				network: 'open-egress',
				shells: { sh: '/bin/sh' },
				readonlyPaths: ['/opt/tools'],
				environment: { PATH: '/opt/tools/bin', VALUE: 'literal $HOME' }
			},
			frozen: [true, true, true, true]
		});
	});

	it.each([
		{ network: 'unrestricted' },
		{ backend: 'process' },
		{ readonlyPaths: ['relative'] },
		{ readonlyPaths: ['/valid\0invalid'] },
		{ shells: { sh: 'sh' } },
		{ shells: { bash: '/bin/bash' } },
		{ shells: { sh: '/bin/sh', powershell: '/bin/pwsh' } },
		{ environment: { 'BAD=KEY': 'value' } },
		{ environment: { '': 'value' } },
		{ environment: { VALUE: 'invalid\0value' } },
		{ profileOverride: '(allow default)' },
		{ extraWritablePaths: ['/'] },
		[],
		'configuration'
	])('rejects invalid or unsupported settings %#', (input) => {
		expect(() => validateConfig(input)).toThrow(MxcConfigError);
	});
});
