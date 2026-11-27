import type { Profile } from 'pi-bring-your-own-sandbox/provider';
import { expect, it } from 'vitest';

import { profilesFor } from './policy.js';

type ProfileCase = readonly [
	workspaceWrites: boolean,
	network: boolean,
	hostUserData: Profile['policy']['hostUserData'],
	exitStatus: Profile['exitStatus']
];

const operations = [
	'exec',
	'files.read',
	'files.list',
	'files.write',
	'search.find',
	'search.grep'
] as const;

function expectedProfiles(
	cases: readonly ProfileCase[],
	capabilities: Profile['capabilities'],
	pathGrantKinds?: Profile['pathGrantKinds']
): readonly Profile[] {
	return cases.map(
		([hostWorkspaceWrites, network, hostUserData, exitStatus]) => ({
			policy: {
				hostWorkspaceWrites,
				network,
				hostUserData,
				hostSystemFiles: 'read-only'
			},
			capabilities,
			processKinds: ['argv', 'shell'],
			shells: ['sh', 'bash'],
			exitStatus,
			terminationScope: 'process-group',
			...(pathGrantKinds !== undefined && { pathGrantKinds })
		})
	);
}

const macOperations = [...operations, 'copy'] as const;

it.each([
	{
		platform: 'darwin',
		profiles: {
			open: expectedProfiles(
				[
					[true, false, 'denied', 'guaranteed'],
					[true, false, 'read-only', 'guaranteed'],
					[true, true, 'denied', 'optional'],
					[true, true, 'read-only', 'optional'],
					[false, false, 'denied', 'guaranteed'],
					[false, false, 'read-only', 'guaranteed'],
					[false, true, 'denied', 'optional'],
					[false, true, 'read-only', 'optional']
				],
				macOperations,
				['read', 'write']
			),
			copy: expectedProfiles(
				[
					[false, false, 'denied', 'guaranteed'],
					[false, false, 'read-only', 'guaranteed'],
					[false, true, 'denied', 'optional'],
					[false, true, 'read-only', 'optional']
				],
				macOperations
			)
		}
	},
	{
		platform: 'linux',
		profiles: {
			open: expectedProfiles(
				[
					[true, false, 'denied', 'optional'],
					[true, true, 'denied', 'optional'],
					[false, false, 'denied', 'optional'],
					[false, true, 'denied', 'optional']
				],
				operations,
				['read', 'write']
			),
			copy: []
		}
	}
] as const)(
	'declares the execution contract for $platform',
	({ platform, profiles }) => {
		expect(profilesFor(platform)).toStrictEqual(profiles);
	}
);

it.each(['freebsd', 'win32'] as const)(
	'declares no usable profile on %s',
	(platform) => {
		expect(profilesFor(platform)).toStrictEqual({ open: [], copy: [] });
	}
);
