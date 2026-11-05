import type { WorkspaceProtection } from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import {
	GitCommandError,
	GitMetadataUnavailableError,
	GitUnavailableError,
	ProtectedHardLinkError,
	ProtectedPathAbsentError,
	ProtectedSymbolicLinkError,
	UncoveredProtectedPathError
} from './errors.js';
import { memoryHost } from './fixtures/host.js';
import { protectedPaths } from './protection.js';

const workspace = '/workspace';
const git = { kind: 'git-metadata' } as const;
const gitPaths =
	'rev-parse --path-format=absolute --git-dir --git-common-dir --git-path hooks';
const gitIncludes =
	'config --show-origin --null --get-regexp ^include(if\\..+)?\\.path$';

function pathResource(path: string): WorkspaceProtection {
	return { kind: 'path', path };
}

function plan(
	resources: readonly WorkspaceProtection[],
	{
		backend = 'seatbelt',
		workspaceAccess = 'read-write',
		gitOutput = {}
	}: {
		readonly backend?: 'seatbelt' | 'bubblewrap';
		readonly workspaceAccess?: 'read-only' | 'read-write';
		readonly gitOutput?: Readonly<
			Record<string, string | GitCommandError | GitUnavailableError>
		>;
	} = {}
) {
	const fixture = memoryHost(
		{
			'/workspace/.pi/settings.json': '{}',
			'/workspace/.envrc': 'use nix',
			'/workspace/src/index.ts': '',
			'/workspace/.git/config': '',
			'/workspace/.git/hooks/pre-commit': '',
			'/workspace/.husky/_/pre-commit': '',
			'/outside/pi': {}
		},
		{
			git: {
				[workspace]: {
					[gitIncludes]: new GitCommandError(gitIncludes.split(' '), 1, ''),
					...gitOutput
				}
			}
		}
	);

	return {
		...fixture,
		run: () =>
			protectedPaths(fixture.host, {
				workspace,
				backend,
				workspaceAccess,
				resources
			})
	};
}

const repository = {
	[gitPaths]: '/workspace/.git\n/workspace/.git\n/workspace/.git/hooks\n'
};

it('adds no grants when the whole workspace is read-only', async () => {
	const { run } = plan([git, pathResource('missing')], {
		backend: 'bubblewrap',
		workspaceAccess: 'read-only'
	});

	expect(await run()).toStrictEqual([]);
});

it.each(['seatbelt', 'bubblewrap'] as const)(
	'protects existing top-level entries with %s',
	async (backend) => {
		const { run } = plan([pathResource('.pi'), pathResource('.envrc')], {
			backend
		});

		expect(await run()).toStrictEqual(['/workspace/.envrc', '/workspace/.pi']);
	}
);

it('requires the top-level entry that contains a nested path', async () => {
	const { run } = plan([pathResource('src/index.ts')]);

	await expect(run()).rejects.toStrictEqual(
		new UncoveredProtectedPathError('/workspace/src/index.ts', '/workspace/src')
	);
});

it.each([
	{ backend: 'seatbelt', expected: ['/workspace/.idea'] },
	{
		backend: 'bubblewrap',
		expected: new ProtectedPathAbsentError('/workspace/.idea')
	}
] as const)(
	'handles an absent entry with $backend',
	async ({ backend, expected }) => {
		const { run } = plan([pathResource('.idea')], { backend });

		await (Array.isArray(expected)
			? expect(run()).resolves.toStrictEqual(expected)
			: expect(run()).rejects.toStrictEqual(expected));
	}
);

it.each([
	{
		backend: 'seatbelt',
		target: '/outside/pi',
		expected: ['/workspace/.pi-link']
	},
	{
		backend: 'seatbelt',
		target: '/workspace/src',
		expected: new UncoveredProtectedPathError(
			'/workspace/src',
			'/workspace/src'
		)
	},
	{
		backend: 'bubblewrap',
		target: '/outside/pi',
		expected: new ProtectedSymbolicLinkError('/workspace/.pi-link')
	}
] as const)(
	'protects a symbolic link to $target with $backend',
	async ({ backend, target, expected }) => {
		const { run, memory } = plan([pathResource('.pi-link')], { backend });

		memory.symlinkSync(target, '/workspace/.pi-link');

		await (Array.isArray(expected)
			? expect(run()).resolves.toStrictEqual(expected)
			: expect(run()).rejects.toStrictEqual(expected));
	}
);

it('rejects a protected file with another hard link', async () => {
	const { run, memory } = plan([pathResource('.pi')]);

	memory.linkSync(
		'/workspace/.pi/settings.json',
		'/workspace/src/settings.json'
	);

	await expect(run()).rejects.toStrictEqual(
		new ProtectedHardLinkError('/workspace/.pi/settings.json')
	);
});

it('rejects a symbolic link inside a protected directory to writable files', async () => {
	const { run, memory } = plan([pathResource('.pi')]);

	memory.symlinkSync('../src/index.ts', '/workspace/.pi/extension.ts');

	await expect(run()).rejects.toStrictEqual(
		new UncoveredProtectedPathError('/workspace/src/index.ts', '/workspace/src')
	);
});

it.each([
	{
		name: 'the repository directory',
		output: repository,
		resources: [git],
		expected: ['/workspace/.git']
	},
	{
		name: 'a hooks path that Git resolves inside the workspace',
		output: {
			[gitPaths]: '/workspace/.git\n/workspace/.git\n/workspace/.husky/_\n'
		},
		resources: [git, pathResource('.husky')],
		expected: ['/workspace/.git', '/workspace/.husky']
	},
	{
		name: 'configuration includes inside the workspace',
		output: {
			...repository,
			[gitIncludes]:
				'file:.git/config\0include.path\n../.gitconfig\0file:.git/config\0includeif.onbranch:x.path\nextra/cfg\0file:/home/user/.gitconfig\0include.path\n~/.gitconfig-work\0'
		},
		resources: [git],
		expected: ['/workspace/.git', '/workspace/.gitconfig']
	},
	{
		name: 'the pointer file of a linked worktree',
		output: {
			[gitPaths]:
				'/repository/.git/worktrees/w\n/repository/.git\n/repository/.git/hooks\n'
		},
		resources: [git],
		expected: ['/workspace/.git']
	}
])('protects Git metadata: $name', async ({ output, resources, expected }) => {
	const { run } = plan(resources, { gitOutput: output });

	expect(await run()).toStrictEqual(expected);
});

it('requires the directory that contains a hooks path inside the workspace', async () => {
	const { run } = plan([git], {
		gitOutput: {
			[gitPaths]: '/workspace/.git\n/workspace/.git\n/workspace/.husky/_\n'
		}
	});

	await expect(run()).rejects.toStrictEqual(
		new UncoveredProtectedPathError('/workspace/.husky/_', '/workspace/.husky')
	);
});

it('reports Git that cannot describe an existing repository', async () => {
	const { run } = plan([git]);
	const cause = new GitCommandError(gitPaths.split(' '), 128, '');

	await expect(run()).rejects.toStrictEqual(
		new GitMetadataUnavailableError(workspace, { cause })
	);
});

it.each([
	{ hasRepository: false, expected: ['/workspace/.git'] },
	{
		hasRepository: true,
		expected: new GitMetadataUnavailableError(workspace, {
			cause: new GitUnavailableError()
		})
	}
])(
	'handles a host without Git when a repository exists: $hasRepository',
	async ({ hasRepository, expected }) => {
		const { run, memory } = plan([git], {
			gitOutput: { [gitPaths]: new GitUnavailableError() }
		});

		if (!hasRepository) {
			memory.rmSync('/workspace/.git', { recursive: true });
		}

		await (Array.isArray(expected)
			? expect(run()).resolves.toStrictEqual(expected)
			: expect(run()).rejects.toStrictEqual(expected));
	}
);

it.each([
	{ backend: 'seatbelt', expected: ['/workspace/.git'] },
	{
		backend: 'bubblewrap',
		expected: new ProtectedPathAbsentError('/workspace/.git')
	}
] as const)(
	'prevents a new repository outside Git with $backend',
	async ({ backend, expected }) => {
		const { run, memory } = plan([git], { backend });

		memory.rmSync('/workspace/.git', { recursive: true });

		await (Array.isArray(expected)
			? expect(run()).resolves.toStrictEqual(expected)
			: expect(run()).rejects.toStrictEqual(expected));
	}
);
