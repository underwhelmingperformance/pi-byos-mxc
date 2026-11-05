import { describe, expect, it } from 'vitest';

import { validateConfig } from './config.js';
import { InvalidSettingsError } from './errors.js';
import { thrown } from './fixtures/thrown.js';

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

	it.each<{ input: unknown; paths: string[] }>([
		{ input: { network: 'unrestricted' }, paths: ['/network'] },
		{ input: { backend: 'process' }, paths: ['/backend'] },
		{ input: { readonlyPaths: ['relative'] }, paths: ['/readonlyPaths/0'] },
		{
			input: { readonlyPaths: ['/valid\0invalid'] },
			paths: ['/readonlyPaths/0']
		},
		{ input: { shells: { sh: 'sh' } }, paths: ['/shells/sh'] },
		{ input: { shells: { bash: '/bin/bash' } }, paths: ['/shells'] },
		{
			input: { shells: { sh: '/bin/sh', powershell: '/bin/pwsh' } },
			paths: ['/shells/powershell']
		},
		{
			input: { environment: { 'BAD=KEY': 'value' } },
			paths: ['/environment/BAD=KEY']
		},
		{ input: { environment: { '': 'value' } }, paths: ['/environment/'] },
		{
			input: { environment: { VALUE: 'invalid\0value' } },
			paths: ['/environment/VALUE']
		},
		{
			input: { profileOverride: '(allow default)' },
			paths: ['/profileOverride']
		},
		{ input: { extraWritablePaths: ['/'] }, paths: ['/extraWritablePaths'] },
		{ input: [], paths: [''] },
		{ input: 'configuration', paths: [''] }
	])(
		'rejects invalid or unsupported settings at $paths',
		({ input, paths }) => {
			expect(thrown(() => validateConfig(input))).toStrictEqual(
				new InvalidSettingsError(paths)
			);
		}
	);
});
