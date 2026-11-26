import type { NetworkPolicy } from '@microsoft/mxc-sdk/v1';
import type {
	Profile,
	SandboxPolicy
} from 'pi-bring-your-own-sandbox/provider';

import type { MxcConfig } from './config.js';
import { UnsupportedBackendError } from './errors.js';
import type { StartMessage } from './supervisor/protocol.js';

const operations = [
	'exec',
	'files.read',
	'files.list',
	'files.write',
	'search.find',
	'search.grep'
] as const;

type NativeBackend = Exclude<MxcConfig['backend'], 'auto'>;

export function profilesFor(platform: NodeJS.Platform): {
	readonly open: readonly Profile[];
	readonly copy: readonly Profile[];
} {
	const backend = platform === 'darwin' ? 'seatbelt' : 'bubblewrap';
	const canCopy = platform === 'darwin';
	const userData =
		platform === 'darwin'
			? (['denied', 'read-only'] as const)
			: (['denied'] as const);
	const capabilities = canCopy
		? ([...operations, 'copy'] as const)
		: operations;
	const build = (isWorkspaceWritable: boolean, isCopy: boolean): Profile[] =>
		([false, true] as const).flatMap((network) =>
			userData.map((hostUserData) => ({
				policy: {
					hostWorkspaceWrites: isWorkspaceWritable,
					network,
					hostUserData,
					hostSystemFiles: 'read-only'
				},
				capabilities,
				processKinds: ['argv', 'shell'],
				shells: ['sh', 'bash'],
				exitStatus:
					networkMode(backend, { network }) === 'denied'
						? 'guaranteed'
						: 'optional',
				terminationScope: 'process-group',
				...(!isCopy && { pathGrantKinds: ['read', 'write'] })
			}))
		);

	return {
		open: [...build(true, false), ...build(false, false)],
		copy: canCopy ? build(false, true) : []
	};
}

export function resolveBackend(
	platform: NodeJS.Platform,
	selection: MxcConfig['backend']
): NativeBackend {
	if (platform === 'darwin' && selection !== 'bubblewrap') {
		return 'seatbelt';
	}

	if (platform === 'linux' && selection !== 'seatbelt') {
		return 'bubblewrap';
	}

	throw new UnsupportedBackendError(platform, selection);
}

export function networkMode(
	backend: NativeBackend,
	policy: Pick<SandboxPolicy, 'network'>
): StartMessage['network'] {
	if (policy.network) {
		return 'open-egress';
	}

	return backend === 'seatbelt' ? 'denied' : 'ip-denied';
}

export function networkPolicy(
	mode: Exclude<StartMessage['network'], 'denied'>
): NetworkPolicy {
	return {
		egress: { default: mode === 'ip-denied' ? 'deny' : 'allow' },
		ingress: { default: 'deny', hostLoopback: 'deny' }
	};
}
