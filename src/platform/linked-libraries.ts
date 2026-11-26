import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { assertDisjointPaths, isPathWithin } from '../paths.js';

const execute = promisify(execFile);
const inspectorOptions = {
	cwd: '/',
	env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
	timeout: 3000
};

const darwinSystemLibraries = ['/usr/lib', '/System/Library'];
const linuxSystemLibraries = ['/usr/lib', '/usr/lib64', '/lib', '/lib64'];

async function darwinLibraryInspector(): Promise<string> {
	try {
		return await realpath('/Library/Developer/CommandLineTools/usr/bin/otool');
	} catch {
		return '/usr/bin/otool';
	}
}

async function linuxLibraryInspector(): Promise<string> {
	try {
		return await realpath('/usr/bin/ldd');
	} catch {
		return '/run/current-system/sw/bin/ldd';
	}
}

export type InspectLinkedLibraries = (filename: string) => Promise<string[]>;

export async function inspectLinkedLibraries(
	filename: string
): Promise<string[]> {
	if (process.platform === 'darwin') {
		const { stdout } = await execute(
			await darwinLibraryInspector(),
			['-L', filename],
			inspectorOptions
		);

		return stdout
			.split('\n')
			.filter((line) => line.startsWith('\t'))
			.map((line) => line.trim().split(' (', 1)[0] ?? '')
			.filter(Boolean);
	}

	const { stdout } = await execute(
		await linuxLibraryInspector(),
		[filename],
		inspectorOptions
	);
	const lines = stdout.split('\n').map((line) => line.trim());

	if (lines.some((line) => line.endsWith(' => not found'))) {
		throw new Error('The executable has an unresolved shared library.');
	}

	return (
		lines
			// ldd can print the ELF interpreter's path on the left of a mapping.
			.flatMap((line) => line.split(' (0x', 1)[0]?.split(' => ') ?? [])
			.filter((library) => path.isAbsolute(library))
	);
}

export function libraryGrants(
	filename: string,
	lookup = filename
): [grant: string, lookup?: string] {
	const storeOutput =
		/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+(?=\/)/u.exec(
			filename
		)?.[0];
	const cellarPackage = /^\/.+?\/Cellar\/[^/]+\/[^/]+(?=\/)/u.exec(
		filename
	)?.[0];

	const grant = storeOutput ?? cellarPackage ?? filename;

	return isPathWithin(grant, lookup) ? [grant] : [grant, lookup];
}

interface LibraryResolver {
	readonly platform: NodeJS.Platform;
	readonly workspace: string;
	readonly inspect: InspectLinkedLibraries;
	readonly realpath: (filename: string) => Promise<string>;
}

export async function linkedLibraryGrants(
	binary: string,
	{ platform, workspace, inspect, realpath }: LibraryResolver
): Promise<string[]> {
	const isDarwin = platform === 'darwin';
	const systemLibraries = isDarwin
		? darwinSystemLibraries
		: linuxSystemLibraries;
	const files = new Set([binary]);
	const grants = new Set<string>();
	const lookupPaths = new Set<string>();
	const pending = [binary];

	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		const libraries = await inspect(file);

		for (const library of libraries) {
			const candidate = library.startsWith('@loader_path/')
				? path.join(path.dirname(file), library.slice('@loader_path/'.length))
				: library.startsWith('@executable_path/')
					? path.join(
							path.dirname(binary),
							library.slice('@executable_path/'.length)
						)
					: library;

			if (!path.isAbsolute(candidate)) {
				throw new Error(
					'The executable uses an unresolved library search path.'
				);
			}

			if (systemLibraries.some((root) => isPathWithin(root, candidate))) {
				continue;
			}

			const resolved = await realpath(candidate);

			if (isDarwin && files.has(resolved)) {
				continue;
			}

			const [grant, lookup] = libraryGrants(
				resolved,
				isDarwin ? resolved : candidate
			);

			assertDisjointPaths(workspace, [candidate, grant]);
			grants.add(grant);

			if (lookup !== undefined) {
				lookupPaths.add(lookup);
			}

			// ldd already includes dependencies of shared libraries.
			if (!isDarwin) {
				continue;
			}

			files.add(resolved);
			pending.push(resolved);
		}
	}

	const canonicalGrants = [...grants];
	const extraLookups = [...lookupPaths].filter((lookup) =>
		canonicalGrants.every((grant) => !isPathWithin(grant, lookup))
	);

	return [...canonicalGrants, ...extraLookups];
}
