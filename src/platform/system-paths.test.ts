import { expect, it, vi } from 'vitest';

import { systemReadonlyPaths } from './system-paths.js';

it.each([
	{
		platform: 'linux',
		resolved: '/opt/orbstack-guest/etc/resolv.conf',
		expected: ['/opt/orbstack-guest/etc/resolv.conf']
	},
	{
		platform: 'linux',
		resolved: '/etc/resolv.conf',
		expected: ['/etc/resolv.conf']
	},
	{ platform: 'darwin', resolved: '/private/etc/resolv.conf', expected: [] }
] as const)(
	'grants only the Linux resolver file: $resolved',
	async ({ platform, resolved, expected }) => {
		const io = {
			canonicalize: vi.fn().mockResolvedValue(resolved),
			isRegularFile: vi.fn().mockResolvedValue(true)
		};

		expect(await systemReadonlyPaths(platform, io)).toStrictEqual(expected);
		expect(io.canonicalize.mock.calls).toStrictEqual(
			platform === 'linux' ? [['/etc/resolv.conf']] : []
		);
		expect(io.isRegularFile.mock.calls).toStrictEqual(
			platform === 'linux' ? [[resolved]] : []
		);
	}
);

it('does not grant a directory through the resolver symlink', async () => {
	const io = {
		canonicalize: vi.fn().mockResolvedValue('/home/laney'),
		isRegularFile: vi.fn().mockResolvedValue(false)
	};

	await expect(systemReadonlyPaths('linux', io)).rejects.toThrow(
		'regular file'
	);
});

it('permits a host without a resolver file', async () => {
	const io = {
		canonicalize: vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error('missing'), { code: 'ENOENT' })
			),
		isRegularFile: vi.fn()
	};

	expect(await systemReadonlyPaths('linux', io)).toStrictEqual([]);
	expect(io.isRegularFile.mock.calls).toStrictEqual([]);
});

it('does not turn an inaccessible resolver into an absent resolver', async () => {
	const error = Object.assign(new Error('denied'), { code: 'EACCES' });
	const io = {
		canonicalize: vi.fn().mockRejectedValue(error),
		isRegularFile: vi.fn()
	};

	await expect(systemReadonlyPaths('linux', io)).rejects.toBe(error);
});
