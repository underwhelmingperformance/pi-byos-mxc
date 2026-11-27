import { mkdtempDisposable, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { canonicalGrantPath } from './grants.js';
import { systemHost } from './host.js';

const prefix = path.join(tmpdir(), 'mxc-grant-');

it.each([
	{ filename: 'link', expected: 'target' },
	{ filename: 'link/child', expected: 'target/child' }
])(
	'resolves $filename through a dangling link',
	async ({ filename, expected }) => {
		await using directory = await mkdtempDisposable(prefix);

		const link = path.join(directory.path, 'link');

		await symlink('target', link);

		const root = await systemHost.fs.realpath(directory.path);

		await expect(
			canonicalGrantPath(systemHost.fs, path.join(directory.path, filename))
		).resolves.toBe(path.join(root, expected));
	}
);

it('keeps a missing name under an existing directory', async () => {
	await using directory = await mkdtempDisposable(prefix);

	const root = await systemHost.fs.realpath(directory.path);

	await expect(
		canonicalGrantPath(systemHost.fs, path.join(directory.path, 'new'))
	).resolves.toBe(path.join(root, 'new'));
});

it('rejects a child path below a regular file', async () => {
	await using directory = await mkdtempDisposable(prefix);

	const file = path.join(directory.path, 'file');

	await writeFile(file, '');

	await expect(
		canonicalGrantPath(systemHost.fs, path.join(file, 'child'))
	).rejects.toMatchObject({ code: 'ENOTDIR' });
});
