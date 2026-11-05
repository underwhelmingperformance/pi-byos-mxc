import path from 'node:path';

import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import {
	InvalidPackageManifestError,
	PackageRootNotFoundError
} from '../errors.js';
import type { Host, HostFileSystem } from '../host.js';

const dependencyMap = Type.Optional(Type.Record(Type.String(), Type.String()));
const manifestValidator = Compile(
	Type.Object({
		dependencies: dependencyMap,
		optionalDependencies: dependencyMap,
		peerDependencies: dependencyMap
	})
);

/**
Returns the canonical directory of the package that contains `entry`.
*/
export async function packageRoot(
	host: Pick<Host, 'packageDirectory'>,
	entry: string
): Promise<string> {
	const root = await host.packageDirectory(entry, entry);

	if (root === undefined) {
		throw new PackageRootNotFoundError(entry);
	}

	return root;
}

async function dependencyNames(
	fs: HostFileSystem,
	root: string
): Promise<string[]> {
	const manifest: unknown = JSON.parse(
		await fs.readFile(path.join(root, 'package.json'), 'utf8')
	);

	if (!manifestValidator.Check(manifest)) {
		throw new InvalidPackageManifestError(root);
	}

	return [
		...new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {})
		])
	];
}

/**
Returns the canonical root of `root` and of every installed package that it can
load through `dependencies`, `optionalDependencies` and `peerDependencies`.
Packages that are not installed cannot be loaded, so the result omits them.
*/
export async function trustedPackages(
	host: Pick<Host, 'fs' | 'packageDirectory'>,
	root: string
): Promise<string[]> {
	const roots = new Set([root]);
	const pending = [root];

	for (
		let current = pending.pop();
		current !== undefined;
		current = pending.pop()
	) {
		const names = await dependencyNames(host.fs, current);

		for (const name of names) {
			const dependency = await host.packageDirectory(
				name,
				path.join(current, 'package.json')
			);

			if (dependency === undefined || roots.has(dependency)) {
				continue;
			}

			roots.add(dependency);
			pending.push(dependency);
		}
	}

	return [...roots];
}
