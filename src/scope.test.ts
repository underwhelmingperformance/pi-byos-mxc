import { expect, it } from 'vitest';

import { UnsupportedGrantError } from './errors.js';
import { thrown } from './fixtures/thrown.js';
import { assertSystemGrants, SYSTEM_ROOTS } from './scope.js';

it.each([
	{ platform: 'darwin', grants: ['/opt/homebrew/bin', '/usr/local/bin/node'] },
	{ platform: 'darwin', grants: ['/nix/store/abc-node-24/bin/node'] },
	{
		platform: 'darwin',
		grants: ['/Applications/Xcode.app/Contents/Developer']
	},
	{
		platform: 'linux',
		grants: ['/usr/lib/jvm', '/opt/node', '/run/current-system/sw/bin/bash']
	}
] as const)(
	'accepts system and runtime grants on $platform: $grants',
	({ platform, grants }) => {
		expect(
			thrown(() => {
				assertSystemGrants(platform, grants);
			})
		).toBeUndefined();
	}
);

it.each([
	{ platform: 'darwin', grant: '/Users/user/.local/share/mise/installs/node' },
	{ platform: 'darwin', grant: '/' },
	{ platform: 'darwin', grant: '/System' },
	{ platform: 'darwin', grant: '/System/Volumes/Data/Users/user' },
	{ platform: 'darwin', grant: '/Volumes/External/tools' },
	{ platform: 'darwin', grant: '/private/var/folders/xy/T/tools' },
	{ platform: 'linux', grant: '/home/user/.cargo/bin' },
	{ platform: 'linux', grant: '/srv/data' },
	{ platform: 'linux', grant: '/usrlocal/bin' }
] as const)(
	'rejects a grant outside them on $platform: $grant',
	({ platform, grant }) => {
		expect(
			thrown(() => {
				assertSystemGrants(platform, [grant]);
			})
		).toStrictEqual(
			new UnsupportedGrantError(grant, SYSTEM_ROOTS[platform] ?? [])
		);
	}
);
