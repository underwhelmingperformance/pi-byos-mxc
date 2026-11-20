import type {
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/api';

import { MxcBackend } from './backend.js';
import type { MxcConfig } from './config.js';
import { validateConfig } from './config.js';
import { EFFECTIVE_POLICY } from './policy.js';
import type { ReviewSource } from './review-snapshot.js';

type MxcProvider = SandboxProvider<MxcConfig> & {
	readonly policies: SandboxProvider<MxcConfig>['policies'] & {
		readonly workspaceRelationship: readonly ['shared'];
	};
	readonly openReviewSnapshot?: (
		request: SandboxOpenRequest<MxcConfig> & { readonly source: ReviewSource },
		context: SandboxOpenContext
	) => ReturnType<typeof MxcBackend.open>;
};

export const provider: MxcProvider = {
	id: 'mxc',
	label: 'Microsoft MXC (experimental)',
	protocolVersion: 1,
	capabilities: {
		operations: [
			'exec',
			'workspace.protection',
			'files.read',
			'files.list',
			'files.write',
			'search.find',
			'search.grep'
		],
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
	...(process.platform === 'darwin' && {
		openReviewSnapshot: (request, context) =>
			MxcBackend.open(request, context, {}, request.source)
	}),
	open: (request, context) => MxcBackend.open(request, context)
};
