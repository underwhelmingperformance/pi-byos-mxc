import { BlockList, isIPv4, isIPv6 } from 'node:net';
import path from 'node:path';

import { hostSystemRoots } from 'pi-bring-your-own-sandbox/provider';

import { ResolverNotFileError } from '../errors.js';
import type { HostFileSystem } from '../host.js';
import { compareText, isPathWithin } from '../paths.js';

type SystemPlatform = keyof typeof hostSystemRoots;

const generatedCommonReads = [
	'/bin',
	'/sbin',
	'/usr/bin',
	'/usr/sbin',
	'/usr/lib',
	'/usr/libexec',
	'/usr/share'
];

// MXC 1.0.1 provides these subtrees in its generated profiles.
const generatedReads: Record<SystemPlatform, readonly string[]> = {
	darwin: [...generatedCommonReads, '/System', '/Library', '/private/etc'],
	linux: [...generatedCommonReads, '/lib', '/lib64', '/usr/lib64', '/etc']
};

export function isHostSystemPath(
	platform: NodeJS.Platform,
	filename: string
): boolean {
	return (
		(platform === 'darwin' || platform === 'linux') &&
		hostSystemRoots[platform].some((root) => isPathWithin(root, filename))
	);
}

const loopback = new BlockList();

loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

// Mirrors the MXC 1.0.1 Bubblewrap check for replacing the sandbox's resolver
// with slirp's forwarder. MXC skips that replacement when the filesystem policy
// grants the resolver file, so the adapter must not grant a file that MXC would
// replace.
function isLoopbackOnly(contents: string): boolean {
	let hasIPv4Loopback = false;

	for (const line of contents.split(/\r?\n/u)) {
		if (/^\s/u.test(line)) {
			continue;
		}

		const [keyword, value] = line.trim().split(/\s+/u, 2);

		if (keyword !== 'nameserver' || value === undefined) {
			continue;
		}

		const address = value.split('%', 1)[0] ?? value;

		if (isIPv4(address) && loopback.check(address, 'ipv4')) {
			hasIPv4Loopback = true;

			continue;
		}

		if (!(isIPv6(address) && loopback.check(address, 'ipv6'))) {
			return false;
		}
	}

	return hasIPv4Loopback;
}

export async function systemReadonlyPaths(
	platform: NodeJS.Platform,
	fs: HostFileSystem
): Promise<string[]> {
	if (platform !== 'linux') {
		return [];
	}

	try {
		const resolver = await fs.realpath('/etc/resolv.conf');
		const metadata = await fs.stat(resolver);

		if (!metadata.isFile()) {
			throw new ResolverNotFileError(resolver);
		}

		return isLoopbackOnly(await fs.readFile(resolver, 'utf8'))
			? []
			: [resolver];
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return [];
		}

		throw error;
	}
}

async function linuxRuntimeMasks(fs: HostFileSystem): Promise<string[]> {
	try {
		const alias = await fs.realpath('/var/run');

		return alias === '/run' ? ['/run'] : ['/run', alias];
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return ['/run'];
		}

		throw error;
	}
}

async function presentSystemRoot(
	fs: HostFileSystem,
	filename: string
): Promise<string | undefined> {
	try {
		const metadata = await fs.stat(filename);

		return metadata.isDirectory() ? filename : undefined;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}

		throw error;
	}
}

export async function generatedSystemMounts(
	fs: HostFileSystem,
	platform: SystemPlatform,
	hasNetwork: boolean,
	systemRoots = hostSystemRoots[platform]
) {
	const deniedPaths =
		platform === 'linux' && !hasNetwork ? await linuxRuntimeMasks(fs) : [];
	const explicitRoots = systemRoots.filter(
		(root) =>
			deniedPaths.every((mask) => !isPathWithin(root, mask)) &&
			(deniedPaths.some((mask) => isPathWithin(mask, root)) ||
				generatedReads[platform].every(
					(baseline) => !isPathWithin(baseline, root)
				))
	);
	const present = await Promise.all(
		explicitRoots.map((root) => presentSystemRoot(fs, root))
	);

	return {
		deniedPaths,
		readonlyPaths: present.filter((root) => root !== undefined)
	};
}

// MXC 1.0.1 read-only binds these directories into every Bubblewrap sandbox so
// the resolver configuration symlinks keep working. Their service sockets let
// a sandboxed command ask a host daemon to resolve names outside the sandbox's
// network namespace.
const RESOLVER_DIRECTORIES = [
	'/run/systemd/resolve',
	'/run/NetworkManager',
	'/run/resolvconf'
];

async function socketsIn(
	fs: HostFileSystem,
	directory: string
): Promise<string[]> {
	let names: string[];

	try {
		names = await fs.readdir(directory);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return [];
		}

		throw error;
	}

	const sockets: string[] = [];

	for (const name of names.toSorted(compareText)) {
		const filename = path.join(directory, name);
		const metadata = await fs.lstat(filename);

		if (metadata.isSocket()) {
			sockets.push(filename);
		} else if (metadata.isDirectory()) {
			sockets.push(...(await socketsIn(fs, filename)));
		}
	}

	return sockets;
}

/**
Returns the sockets in the resolver directories that MXC mounts on Linux. Deny
them to stop sandboxed commands from resolving names through host services.
Sockets created after this call remain reachable until the next call.
*/
export async function resolverSockets(
	platform: NodeJS.Platform,
	fs: HostFileSystem
): Promise<string[]> {
	if (platform !== 'linux') {
		return [];
	}

	const sockets = await Promise.all(
		RESOLVER_DIRECTORIES.map((directory) => socketsIn(fs, directory))
	);

	return sockets.flat().toSorted(compareText);
}
