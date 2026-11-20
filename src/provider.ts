import type { SandboxProvider } from 'pi-bring-your-own-sandbox/api';

import { MxcBackend } from './backend.js';
import type { MxcConfig } from './config.js';
import { validateConfig } from './config.js';
import { canCopy, EFFECTIVE_POLICY, operations } from './policy.js';

export const provider: SandboxProvider<MxcConfig> = {
	id: 'mxc',
	label: 'Microsoft MXC (experimental)',
	protocolVersion: 1,
	capabilities: {
		operations,
		processKinds: ['shell'],
		shells: ['sh', 'bash'],
		exitStatus: 'optional',
		terminationScope: 'process-group'
	},
	policies: {
		workspaceRelationship: ['shared'],
		workspaceAccess: ['read-write', 'read-only'],
		filesystemScope: ['provider-default', 'system-read-only'],
		networkAccess:
			process.platform === 'darwin'
				? ['provider-default', 'denied']
				: ['provider-default']
	},
	defaultPolicy: EFFECTIVE_POLICY,
	validateConfig,
	...(canCopy && {
		copy: (request, context) =>
			MxcBackend.open(request, context, {}, request.source)
	}),
	open: (request, context) => MxcBackend.open(request, context)
};
