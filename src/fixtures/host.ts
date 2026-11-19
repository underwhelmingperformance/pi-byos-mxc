import type { NestedDirectoryJSON } from 'memfs';
import { memfs } from 'memfs';

import { GitCommandError, GitUnavailableError } from '../errors.js';
import type { Host, HostEnvironment, HostFileSystem } from '../host.js';

type FileMetadata = Awaited<ReturnType<HostFileSystem['stat']>>;

interface MemoryStats extends Omit<
	FileMetadata,
	'dev' | 'ino' | 'size' | 'nlink'
> {
	readonly dev: number | bigint;
	readonly ino: number | bigint;
	readonly size: number | bigint;
	readonly nlink: number | bigint;
}

function metadata(stats: MemoryStats, isSocket: boolean): FileMetadata {
	return {
		dev: Number(stats.dev),
		ino: Number(stats.ino),
		size: Number(stats.size),
		nlink: Number(stats.nlink),
		isDirectory: () => stats.isDirectory(),
		isFile: () => stats.isFile() && !isSocket,
		isSocket: () => isSocket,
		isSymbolicLink: () => stats.isSymbolicLink()
	};
}

const TEST_ENVIRONMENT: HostEnvironment = Object.freeze({
	platform: 'darwin',
	arch: 'arm64',
	nodeVersion: '24.22.2',
	execPath: '/runtime/node/bin/node',
	temporaryDirectory: '/tmp',
	homeDirectory: '/home/user'
});

interface MemoryHostOptions {
	/**
	Overrides for the default test environment.
	*/
	readonly environment?: Partial<HostEnvironment>;

	/**
	Maps a base file to the package directories that Node would use for each
	specifier from that file.
	*/
	readonly packages?: Readonly<
		Record<string, Readonly<Record<string, string>>>
	>;

	/**
	Maps a directory and space-separated Git arguments to Git's output or to the
	error that the command rejects with. Any other command rejects with exit
	status 128, as Git does outside a repository.
	*/
	readonly git?: Readonly<
		Record<
			string,
			Readonly<Record<string, string | GitCommandError | GitUnavailableError>>
		>
	>;

	/**
	Files that `stat` and `lstat` report as sockets, because memfs cannot create
	sockets.
	*/
	readonly sockets?: readonly string[];
}

/**
An in-memory host for unit tests. The filesystem starts with `files`, and IDs
are sequential UUIDs.
*/
export function memoryHost(
	files: NestedDirectoryJSON = {},
	options: MemoryHostOptions = {}
) {
	const { fs: memory } = memfs({ '/tmp': {}, ...files });
	const volume = memory.promises;
	const sockets = new Set(options.sockets);
	let count = 0;
	const filesystem: HostFileSystem = {
		access: (filename, mode) => volume.access(filename, mode),
		async lstat(filename) {
			const stats = await volume.lstat(filename);

			return metadata(stats, sockets.has(filename));
		},
		mkdir: (directory, options) => volume.mkdir(directory, options),
		async readdir(directory) {
			const names = await volume.readdir(directory);

			return names.map(String);
		},
		readFile: async (filename, encoding) =>
			String(await volume.readFile(filename, encoding)),
		readlink: async (filename) => String(await volume.readlink(filename)),
		realpath: async (filename) => String(await volume.realpath(filename)),
		rename: (source, destination) => volume.rename(source, destination),
		rm: (filename, options) => volume.rm(filename, options),
		async stat(filename) {
			const stats = await volume.stat(filename);
			const canonical = await volume.realpath(filename);

			return metadata(stats, sockets.has(String(canonical)));
		},
		unlink: (filename) => volume.unlink(filename),
		writeFile: (filename, data, options) =>
			volume.writeFile(filename, data, options)
	};
	const host: Host = {
		fs: filesystem,
		environment: { ...TEST_ENVIRONMENT, ...options.environment },
		randomId: () => {
			count++;

			return `00000000-0000-4000-8000-${count.toString().padStart(12, '0')}`;
		},
		packageDirectory: (specifier, base) =>
			Promise.resolve(options.packages?.[base]?.[specifier]),
		git(directory, gitArguments) {
			const output = options.git?.[directory]?.[gitArguments.join(' ')];

			return typeof output === 'string'
				? Promise.resolve(output)
				: Promise.reject(output ?? new GitCommandError(gitArguments, 128, ''));
		}
	};

	return { host, memory };
}
