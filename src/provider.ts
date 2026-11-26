import type { SandboxProvider } from 'pi-bring-your-own-sandbox/provider';

import { MxcBackend } from './backend.js';
import type { MxcConfig } from './config.js';
import { validateConfig } from './config.js';
import { profilesFor } from './policy.js';

export const providerDeclaration = {
	id: 'mxc',
	label: 'Microsoft MXC (experimental)',
	profiles: profilesFor(process.platform)
};

export function createProvider(): SandboxProvider<MxcConfig> {
	return {
		...providerDeclaration,
		validateConfig,
		...(providerDeclaration.profiles.copy.length > 0 && {
			copy: (request, context) =>
				MxcBackend.open(request, context, {}, request.source)
		}),
		open: (request, context) => MxcBackend.open(request, context)
	};
}
