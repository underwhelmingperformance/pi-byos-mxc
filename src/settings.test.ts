import { HOST_CONFIGURATION_PROTECTION } from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { validateConfig } from './config.js';
import { InvalidSettingsFileError, SettingsFileSyntaxError } from './errors.js';
import { memoryHost } from './fixtures/host.js';
import { readSettings, SETTINGS_FILE } from './settings.js';

const file = `/home/user/.pi/agent/${SETTINGS_FILE}`;

function read(contents?: string) {
	const { host } = memoryHost(
		contents === undefined
			? { '/home/user/.pi/agent': {} }
			: { [file]: contents }
	);

	return readSettings(host.fs, '/home/user/.pi/agent');
}

it('uses the standard mode with the network off when there is no settings file', async () => {
	expect(await read()).toStrictEqual({
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default',
			workspaceProtection: HOST_CONFIGURATION_PROTECTION
		},
		configuration: validateConfig({ network: 'ip-denied' })
	});
});

it.each([
	{
		mode: 'standard',
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default'
		}
	},
	{
		mode: 'strict',
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'system-read-only'
		}
	},
	{
		mode: 'read-only',
		policy: {
			workspaceAccess: 'read-only',
			filesystemScope: 'provider-default'
		}
	}
] as const)(
	'maps the $mode mode to a sandbox policy',
	async ({ mode, policy }) => {
		const settings = await read(JSON.stringify({ mode }));

		expect(settings.policy).toStrictEqual({
			...policy,
			networkAccess: 'provider-default',
			workspaceProtection: HOST_CONFIGURATION_PROTECTION
		});
	}
);

it.each([
	{ network: 'off', expected: 'ip-denied' },
	{ network: 'on', expected: 'open-egress' }
] as const)(
	'maps the network setting $network',
	async ({ network, expected }) => {
		const settings = await read(JSON.stringify({ network }));

		expect(settings.configuration.network).toBe(expected);
	}
);

it('requests denied networking for ordinary tools when selected', async () => {
	const settings = await read(JSON.stringify({ network: 'denied' }));

	expect(settings.policy).toStrictEqual({
		workspaceAccess: 'read-write',
		filesystemScope: 'provider-default',
		networkAccess: 'denied',
		workspaceProtection: HOST_CONFIGURATION_PROTECTION
	});
});

it('passes toolchain, shell, environment and protection settings through', async () => {
	const settings = await read(
		JSON.stringify({
			backend: 'seatbelt',
			readonlyPaths: ['/opt/homebrew'],
			shells: { sh: '/bin/sh' },
			environment: { LANG: 'C.UTF-8' },
			protectPaths: ['.husky'],
			userShell: 'sh'
		})
	);

	expect(settings).toStrictEqual({
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default',
			workspaceProtection: [
				...HOST_CONFIGURATION_PROTECTION,
				{ kind: 'path', path: '.husky' }
			]
		},
		configuration: validateConfig({
			backend: 'seatbelt',
			network: 'ip-denied',
			readonlyPaths: ['/opt/homebrew'],
			shells: { sh: '/bin/sh' },
			environment: { LANG: 'C.UTF-8' }
		}),
		userShell: 'sh'
	});
});

it('reports a settings file that is not JSON', async () => {
	await expect(read('{"mode":')).rejects.toStrictEqual(
		new SettingsFileSyntaxError(file, {
			cause: new SyntaxError('Unexpected end of JSON input')
		})
	);
});

it.each([
	{ contents: { mode: 'paranoid' }, paths: ['/mode'] },
	{ contents: { network: 'ip-denied' }, paths: ['/network'] },
	{ contents: { protectPaths: ['../outside'] }, paths: ['/protectPaths/0'] },
	{ contents: { protectPaths: ['/etc'] }, paths: ['/protectPaths/0'] },
	{ contents: { protectPaths: ['a//b'] }, paths: ['/protectPaths/0'] },
	{ contents: { protectPaths: ['a/./b'] }, paths: ['/protectPaths/0'] },
	{ contents: { protectPaths: ['C:\\x'] }, paths: ['/protectPaths/0'] },
	{ contents: { readonlyPaths: ['relative'] }, paths: ['/readonlyPaths/0'] },
	{ contents: { policy: {} }, paths: ['/policy'] },
	{ contents: [], paths: [''] }
])('reports invalid settings at $paths', async ({ contents, paths }) => {
	await expect(read(JSON.stringify(contents))).rejects.toStrictEqual(
		new InvalidSettingsFileError(file, paths)
	);
});
