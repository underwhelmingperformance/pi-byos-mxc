import type {
	Profile,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/provider';

import { MxcBackend } from './backend.js';
import type { MxcConfig } from './config.js';
import { validateConfig } from './config.js';
import { profilesFor, resolveBackend } from './policy.js';

const unsupportedProfile: Profile = {
	policy: {
		hostWorkspaceWrites: false,
		network: false,
		hostUserData: 'denied',
		hostSystemFiles: 'denied'
	},
	capabilities: ['exec'],
	processKinds: ['argv'],
	shells: [],
	exitStatus: 'optional',
	terminationScope: 'none'
};

export function providerDeclaration() {
	const profiles = profilesFor(process.platform);

	return {
		id: 'mxc',
		label: 'Microsoft MXC (experimental)',
		profiles:
			profiles.open.length === 0
				? { open: [unsupportedProfile], copy: [] }
				: profiles
	};
}

export function createProvider(): SandboxProvider<MxcConfig> {
	resolveBackend(process.platform, 'auto');

	const declaration = providerDeclaration();

	return {
		...declaration,
		validateConfig,
		...(declaration.profiles.copy.length > 0 && {
			copy: (request, context) =>
				MxcBackend.open(request, context, {}, request.source)
		}),
		open: (request, context) => MxcBackend.open(request, context)
	};
}
