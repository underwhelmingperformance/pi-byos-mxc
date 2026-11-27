import path from 'node:path';

import { hostSystemRoots } from 'pi-bring-your-own-sandbox/provider';

import type { HostFileSystem } from '../host.js';
import { compareText, isPathWithin } from '../paths.js';

export const DARWIN_SYSTEM_VOLUMES = '/System/Volumes';
export const DARWIN_DATA_VOLUME = '/System/Volumes/Data';
export const DARWIN_CRYPTEX_DYLD =
	'/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld';

async function deniedEntries(
	fs: HostFileSystem,
	filename: string,
	allowed: readonly string[]
): Promise<string[]> {
	if (allowed.some((root) => isPathWithin(root, filename))) {
		return [];
	}

	if (allowed.every((root) => !isPathWithin(filename, root))) {
		return [filename];
	}

	let entries: string[];

	try {
		entries = await fs.readdir(filename);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return [];
		}

		throw error;
	}

	const children = await Promise.all(
		entries.map((entry) =>
			deniedEntries(fs, path.join(filename, entry), allowed)
		)
	);

	return children.flat();
}

export async function generatedSeatbeltDenials(
	fs: HostFileSystem,
	granted: readonly string[]
): Promise<string[]> {
	const trees = ['/Library', DARWIN_SYSTEM_VOLUMES];
	const allowed = [
		...hostSystemRoots.darwin.filter((root) =>
			trees.some((tree) => isPathWithin(tree, root))
		),
		DARWIN_CRYPTEX_DYLD,
		...granted
	];
	const denials = await Promise.all(
		trees.map((tree) => deniedEntries(fs, tree, allowed))
	);

	return denials.flat().toSorted(compareText);
}
