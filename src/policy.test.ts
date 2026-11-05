import { expect, it } from 'vitest';

import { UnsupportedBackendError } from './errors.js';
import { thrown } from './fixtures/thrown.js';
import { EFFECTIVE_POLICY, networkPolicy, resolveBackend } from './policy.js';

it('describes delegated restrictions without claiming strict containment', () => {
	expect(EFFECTIVE_POLICY).toStrictEqual({
		workspaceAccess: 'read-write',
		filesystemScope: 'provider-default',
		networkAccess: 'provider-default'
	});
});

it.each([
	{ platform: 'darwin', selection: 'auto', expected: 'seatbelt' },
	{ platform: 'linux', selection: 'auto', expected: 'bubblewrap' },
	{ platform: 'darwin', selection: 'seatbelt', expected: 'seatbelt' },
	{ platform: 'linux', selection: 'bubblewrap', expected: 'bubblewrap' }
] as const)(
	'selects $expected on $platform',
	({ platform, selection, expected }) => {
		expect(resolveBackend(platform, selection)).toBe(expected);
	}
);

it.each([
	{ platform: 'darwin', selection: 'bubblewrap' },
	{ platform: 'linux', selection: 'seatbelt' },
	{ platform: 'win32', selection: 'auto' }
] as const)(
	'rejects $selection on $platform without fallback',
	({ platform, selection }) => {
		expect(thrown(() => resolveBackend(platform, selection))).toStrictEqual(
			new UnsupportedBackendError(platform, selection)
		);
	}
);

it.each([
	{ mode: 'ip-denied', egress: 'deny' },
	{ mode: 'open-egress', egress: 'allow' }
] as const)('maps $mode to explicit directional policy', ({ mode, egress }) => {
	expect(networkPolicy(mode)).toStrictEqual({
		egress: { default: egress },
		ingress: { default: 'deny', hostLoopback: 'deny' }
	});
});
