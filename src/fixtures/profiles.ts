import type {
	Profile,
	SandboxPolicy
} from 'pi-bring-your-own-sandbox/provider';

import { profilesFor } from '../policy.js';

export const defaultPolicy: SandboxPolicy = {
	hostWorkspaceWrites: true,
	network: false,
	hostUserData: 'denied',
	hostSystemFiles: 'read-only'
};

export function fixtureProfile(
	policy: Partial<SandboxPolicy> = {},
	platform = process.platform,
	mode: 'open' | 'copy' = 'open'
): Profile {
	const expected = {
		...defaultPolicy,
		...(mode === 'copy' && { hostWorkspaceWrites: false }),
		...policy
	};
	const profile = profilesFor(platform)[mode].find(
		({ policy: candidate }) =>
			candidate.hostWorkspaceWrites === expected.hostWorkspaceWrites &&
			candidate.network === expected.network &&
			candidate.hostUserData === expected.hostUserData &&
			candidate.hostSystemFiles === expected.hostSystemFiles
	);

	if (profile === undefined) {
		throw new Error('The fixture policy does not select an MXC profile.');
	}

	return profile;
}
