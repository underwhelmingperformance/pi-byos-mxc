import type { NetworkPolicy } from '@microsoft/mxc-sdk/v1';
import type { SandboxPolicy } from 'pi-bring-your-own-sandbox/api';

import type { MxcConfig } from './config.js';
import { MxcConfigError } from './config.js';

type NativeBackend = Exclude<MxcConfig['backend'], 'auto'>;

export const EFFECTIVE_POLICY: SandboxPolicy = Object.freeze({
	workspaceAccess: 'read-write',
	filesystemScope: 'provider-default',
	networkAccess: 'provider-default'
});

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

	throw new MxcConfigError(
		'MXC requires Seatbelt on macOS or Bubblewrap on Linux. Select a backend matching the host.'
	);
}

export function networkPolicy(mode: MxcConfig['network']): NetworkPolicy {
	return {
		egress: { default: mode === 'ip-denied' ? 'deny' : 'allow' },
		ingress: { default: 'deny', hostLoopback: 'deny' }
	};
}
