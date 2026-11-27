import { expect, it } from 'vitest';

import { ResolverNotFileError } from '../errors.js';
import { FileSystemError } from '../fixtures/errors.js';
import { memoryHost } from '../fixtures/host.js';

import {
	generatedSystemMounts,
	resolverSockets,
	systemReadonlyPaths
} from './system-paths.js';

const external = 'nameserver 0.250.250.200\n';

it('masks the shared runtime directory once when /var/run aliases /run', async () => {
	const { host, memory } = memoryHost({ '/run': {}, '/var': {} });

	memory.symlinkSync('/run', '/var/run');

	await expect(
		generatedSystemMounts(host.fs, 'linux', false)
	).resolves.toStrictEqual({
		deniedPaths: ['/run'],
		readonlyPaths: []
	});
});

it('retains present SDK system roots without rebinding the runtime mask', async () => {
	const { host, memory } = memoryHost({
		'/etc': {},
		'/run/daemon': {},
		'/nix/store/system': {},
		'/var': {}
	});

	memory.symlinkSync('/run', '/var/run');
	memory.symlinkSync('/nix/store/system', '/run/current-system');

	await expect(
		generatedSystemMounts(host.fs, 'linux', false, [
			'/etc',
			'/nix/store',
			'/run',
			'/run/current-system',
			'/run/absent'
		])
	).resolves.toStrictEqual({
		deniedPaths: ['/run'],
		readonlyPaths: ['/nix/store', '/run/current-system']
	});
});

it.each([
	{
		platform: 'linux',
		target: '/opt/orbstack-guest/etc/resolv.conf',
		expected: ['/opt/orbstack-guest/etc/resolv.conf']
	},
	{
		platform: 'linux',
		target: '/etc/resolv.conf',
		expected: ['/etc/resolv.conf']
	},
	{ platform: 'darwin', target: '/private/etc/resolv.conf', expected: [] }
] as const)(
	'grants only the Linux resolver file: $target',
	async ({ platform, target, expected }) => {
		const { host, memory } = memoryHost({ [target]: external });

		if (target !== '/etc/resolv.conf') {
			memory.mkdirSync('/etc', { recursive: true });
			memory.symlinkSync(target, '/etc/resolv.conf');
		}

		expect(await systemReadonlyPaths(platform, host.fs)).toStrictEqual(
			expected
		);
	}
);

it.each([
	{ contents: 'nameserver 127.0.0.53\noptions edns0\n', isGranted: false },
	{ contents: 'nameserver 127.0.0.1\nnameserver ::1\n', isGranted: false },
	{ contents: 'nameserver 127.0.0.53\r\nsearch lan\r\n', isGranted: false },
	{ contents: 'nameserver ::1\n', isGranted: true },
	{
		contents: 'nameserver 127.0.0.53\nnameserver 192.0.2.2\n',
		isGranted: true
	},
	{
		contents: 'nameserver fe80::1%eth0\nnameserver 127.0.0.1\n',
		isGranted: true
	},
	{
		contents: ' nameserver 192.0.2.2\nnameserver 127.0.0.1\n',
		isGranted: false
	},
	{
		contents: '# nameserver 192.0.2.2\nnameserver 127.0.0.1\n',
		isGranted: false
	},
	{ contents: 'search lan\n', isGranted: true }
])(
	'leaves MXC to replace a loopback-only resolver: $contents',
	async ({ contents, isGranted }) => {
		const { host } = memoryHost({ '/etc/resolv.conf': contents });

		expect(await systemReadonlyPaths('linux', host.fs)).toStrictEqual(
			isGranted ? ['/etc/resolv.conf'] : []
		);
	}
);

it('does not grant a directory through the resolver symlink', async () => {
	const { host, memory } = memoryHost({
		'/home/user/.ssh': {},
		'/etc': {}
	});

	memory.symlinkSync('/home/user', '/etc/resolv.conf');

	await expect(systemReadonlyPaths('linux', host.fs)).rejects.toStrictEqual(
		new ResolverNotFileError('/home/user')
	);
});

it('permits a host without a resolver file', async () => {
	const { host } = memoryHost();

	expect(await systemReadonlyPaths('linux', host.fs)).toStrictEqual([]);
});

it('does not turn an inaccessible resolver into an absent resolver', async () => {
	const { host } = memoryHost();
	const error = new FileSystemError('EACCES', 'realpath', '/etc/resolv.conf');

	await expect(
		systemReadonlyPaths('linux', {
			...host.fs,
			realpath: () => Promise.reject(error)
		})
	).rejects.toBe(error);
});

it.each([
	{
		platform: 'linux',
		expected: [
			'/run/NetworkManager/private-dhcp',
			'/run/systemd/resolve/io.systemd.Resolve',
			'/run/systemd/resolve/io.systemd.Resolve.Monitor'
		]
	},
	{ platform: 'darwin', expected: [] }
] as const)(
	'denies the resolver service sockets that MXC mounts on $platform',
	async ({ platform, expected }) => {
		const sockets = [
			'/run/systemd/resolve/io.systemd.Resolve',
			'/run/systemd/resolve/io.systemd.Resolve.Monitor',
			'/run/NetworkManager/private-dhcp',
			'/run/dbus/system_bus_socket'
		];
		const { host } = memoryHost(
			{
				'/run/systemd/resolve/stub-resolv.conf': 'nameserver 127.0.0.53\n',
				'/run/NetworkManager/no-stub-resolv.conf': '',
				...Object.fromEntries(sockets.map((socket) => [socket, '']))
			},
			{ sockets }
		);

		expect(await resolverSockets(platform, host.fs)).toStrictEqual(expected);
	}
);
