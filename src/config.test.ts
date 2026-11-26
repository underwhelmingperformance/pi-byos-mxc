import { describe, expect, it } from 'vitest';

import { validateConfig } from './config.js';
import { InvalidSettingsError } from './errors.js';
import { thrown } from './fixtures/thrown.js';

describe('MXC configuration', () => {
	it('uses explicit runtime defaults without host environment inheritance', () => {
		expect(validateConfig({})).toStrictEqual({
			backend: 'auto',
			shells: { sh: '/bin/sh', bash: '/bin/bash' },
			protectPaths: [],
			environment: {}
		});
	});

	it('snapshots and freezes validated provider settings', () => {
		const input = {
			backend: 'seatbelt',
			shells: { sh: '/bin/sh' },
			protectPaths: ['tools'],
			environment: { PATH: '/opt/tools/bin', VALUE: 'literal $HOME' }
		};
		const result = validateConfig(input);

		input.protectPaths.push('private');
		input.environment.VALUE = 'changed';
		expect({
			result,
			frozen: [
				result,
				result.shells,
				result.protectPaths,
				result.environment
			].map((value) => Object.isFrozen(value))
		}).toStrictEqual({
			result: {
				backend: 'seatbelt',
				shells: { sh: '/bin/sh', bash: '/bin/bash' },
				protectPaths: ['tools'],
				environment: { PATH: '/opt/tools/bin', VALUE: 'literal $HOME' }
			},
			frozen: [true, true, true, true]
		});
	});

	it.each<{ input: unknown; paths: string[] }>([
		{ input: { network: 'unrestricted' }, paths: ['/network'] },
		{ input: { backend: 'process' }, paths: ['/backend'] },
		{ input: { protectPaths: ['../relative'] }, paths: ['/protectPaths/0'] },
		{
			input: { protectPaths: ['/valid\0invalid'] },
			paths: ['/protectPaths/0']
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
