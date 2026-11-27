import { expect, it } from 'vitest';

import { offlineProfile } from './seatbelt.js';

it.each([
	{ hostUserData: 'denied', read: ['/'], deniesAlias: true },
	{ hostUserData: 'read-only', read: [], deniesAlias: false }
] as const)(
	'uses the declared $hostUserData host user data policy',
	({ hostUserData, read, deniesAlias }) => {
		const profile = offlineProfile({
			version: 1,
			kind: 'start',
			id: '00000000-0000-4000-8000-000000000001',
			backend: 'seatbelt',
			network: 'denied',
			hostUserData,
			systemRoots: ['/System/Library'],
			command: ':',
			shell: '/bin/sh',
			cwd: '/workspace',
			environment: {},
			readwritePaths: [],
			readonlyPaths: [...read],
			deniedPaths: []
		});

		expect(
			profile.includes('(deny file-read* (subpath "/System/Volumes/Data"))')
		).toBe(deniesAlias);
	}
);
