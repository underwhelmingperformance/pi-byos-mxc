import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const SYSTEM_LIBRARIES = [
	'/usr/lib/',
	'/usr/lib64/',
	'/System/',
	'/lib/',
	'/lib64/'
];

async function linkedLibraries(filename: string): Promise<string[]> {
	if (process.platform === 'darwin') {
		const { stdout } = await execute('/usr/bin/otool', ['-L', filename]);

		return stdout
			.split('\n')
			.slice(1)
			.map((line) => line.trim().split(' (', 1)[0] ?? '')
			.filter((library) => library.startsWith('/'));
	}

	const { stdout } = await execute('ldd', [filename]);

	return stdout
		.matchAll(/(\/\S+) \(0x/gu)
		.map(([, library = '']) => library)
		.toArray();
}

// A library in a `lib` directory may read data from elsewhere in its package
// prefix: Nix's OpenSSL reads its configuration from `<prefix>/etc/ssl`.
function libraryGrant(library: string): string {
	const directory = path.dirname(library);

	return path.basename(directory) === 'lib'
		? path.dirname(directory)
		: directory;
}

/**
Returns read-only grants that let the test host's Node run inside MXC: the
directory of the executable and the package of every shared library outside
the system library directories. Dynamically linked builds, such as Nix's, need
the library packages.
*/
export async function nodeReadonlyPaths(): Promise<string[]> {
	const executable = await realpath(process.execPath);
	const directories = new Set([path.dirname(executable)]);
	const pending = [executable];
	const visited = new Set<string>();

	for (
		let filename = pending.pop();
		filename !== undefined;
		filename = pending.pop()
	) {
		if (visited.has(filename)) {
			continue;
		}

		visited.add(filename);

		const libraries = await linkedLibraries(filename);

		for (const library of libraries) {
			if (SYSTEM_LIBRARIES.some((prefix) => library.startsWith(prefix))) {
				continue;
			}

			const canonical = await realpath(library);

			directories.add(libraryGrant(canonical));
			pending.push(canonical);
		}
	}

	return [...directories];
}
