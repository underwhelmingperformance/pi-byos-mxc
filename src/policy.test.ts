import { expect, it } from 'vitest';

import { UnsupportedBackendError } from './errors.js';
import { defaultPolicy } from './fixtures/profiles.js';
import { thrown } from './fixtures/thrown.js';
import { networkMode, networkPolicy, resolveBackend } from './policy.js';

it.each([
	{ backend: 'seatbelt', network: false, expected: 'denied' },
	{ backend: 'bubblewrap', network: false, expected: 'ip-denied' },
	{ backend: 'seatbelt', network: true, expected: 'open-egress' },
	{ backend: 'bubblewrap', network: true, expected: 'open-egress' }
] as const)(
	'selects $expected for $backend with network $network',
	({ backend, network, expected }) => {
		expect(networkMode(backend, { ...defaultPolicy, network })).toBe(expected);
	}
);

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
