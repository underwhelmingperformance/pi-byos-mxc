import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { UncoveredProtectedPathError } from './errors.js';
import { systemHost } from './host.js';
import { planProtection } from './protection.js';

const execute = promisify(execFile);
const git = { kind: 'git-metadata' } as const;

async function withRepository(
	check: (root: string, repository: string) => Promise<void>
): Promise<void> {
	const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-mxc-git-'));
	const root = await realpath(temporary);
	const repository = path.join(root, 'repository');

	try {
		await mkdir(path.join(repository, '.husky', '_'), { recursive: true });
		await writeFile(path.join(repository, '.gitconfig'), '');
		await execute('git', ['init', '--quiet', repository]);
		await execute('git', [
			'-C',
			repository,
			'config',
			'core.hooksPath',
			'.husky/_'
		]);
		await execute('git', [
			'-C',
			repository,
			'config',
			'include.path',
			'../.gitconfig'
		]);
		await check(root, repository);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function plan(
	workspace: string,
	resources: Parameters<typeof planProtection>[1]['resources']
) {
	return planProtection(systemHost, {
		workspace,
		backend: 'seatbelt',
		workspaceAccess: 'read-write',
		resources
	});
}

it('finds the hooks path and configuration includes that Git uses', async () => {
	await withRepository(async (_root, repository) => {
		await expect(plan(repository, [git])).rejects.toStrictEqual(
			new UncoveredProtectedPathError(
				path.join(repository, '.husky', '_'),
				path.join(repository, '.husky')
			)
		);
		expect(
			await plan(repository, [git, { kind: 'path', path: '.husky' }])
		).toStrictEqual({
			readonlyPaths: ['.git', '.gitconfig', '.husky'].map((entry) =>
				path.join(repository, entry)
			),
			placeholders: [],
			pins: []
		});
	});
});

it('protects the pointer file of a linked worktree', async () => {
	await withRepository(async (root, repository) => {
		const worktree = path.join(root, 'worktree');

		await execute('git', [
			'-C',
			repository,
			'config',
			'--unset',
			'core.hooksPath'
		]);
		await execute(
			'git',
			['-C', repository, 'commit', '--quiet', '--allow-empty', '-m', 'initial'],
			{
				env: {
					...process.env,
					GIT_AUTHOR_NAME: 'Test',
					GIT_AUTHOR_EMAIL: 'test@example.test',
					GIT_COMMITTER_NAME: 'Test',
					GIT_COMMITTER_EMAIL: 'test@example.test'
				}
			}
		);
		await execute('git', [
			'-C',
			repository,
			'worktree',
			'add',
			'--quiet',
			worktree
		]);

		expect(await plan(worktree, [git])).toStrictEqual({
			readonlyPaths: [path.join(worktree, '.git')],
			placeholders: [],
			pins: []
		});
	});
});

it('protects an absent repository entry outside Git', async () => {
	const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-mxc-plain-'));
	const workspace = await realpath(temporary);

	try {
		expect(await plan(workspace, [git])).toStrictEqual({
			readonlyPaths: [path.join(workspace, '.git')],
			placeholders: [],
			pins: []
		});
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
