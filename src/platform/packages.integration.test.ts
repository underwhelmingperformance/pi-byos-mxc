import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { PackageRootNotFoundError } from '../errors.js';
import { systemHost } from '../host.js';

import { packageRoot, trustedPackages } from './packages.js';

const sdk = fileURLToPath(import.meta.resolve('@microsoft/mxc-sdk/v1'));
const entries = {
	'mxc-sdk': sdk,
	koffi: createRequire(sdk).resolve('koffi'),
	typebox: fileURLToPath(import.meta.resolve('typebox')),
	'pi-bring-your-own-sandbox': fileURLToPath(
		import.meta.resolve('pi-bring-your-own-sandbox/provider')
	)
};

async function packageDirectory(name: string, entry: string): Promise<string> {
	let directory = path.dirname(await realpath(entry));

	while (path.basename(directory) !== name) {
		directory = path.dirname(directory);
	}

	return directory;
}

it('finds the packages that the provider can load in the pnpm installation', async () => {
	const root = await packageRoot(systemHost, import.meta.filename);
	const trusted = await trustedPackages(systemHost, root);
	const expected = await Promise.all(
		Object.entries(entries).map(([name, entry]) =>
			packageDirectory(name, entry)
		)
	);

	expect(
		[root, ...expected].filter((directory) => !trusted.includes(directory))
	).toStrictEqual([]);
});

it('does not treat a file outside any package as a package root', async () => {
	await expect(packageRoot(systemHost, '/usr/bin/env')).rejects.toStrictEqual(
		new PackageRootNotFoundError('/usr/bin/env')
	);
});
