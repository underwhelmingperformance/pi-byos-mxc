import { expect, it } from 'vitest';

import {
	GitCommandError,
	GitMetadataUnavailableError,
	GitUnavailableError,
	ProtectedHardLinkError,
	ProtectedSymbolicLinkError,
	UncoveredProtectedPathError
} from './errors.js';
import { memoryHost } from './fixtures/host.js';
import type { Protection } from './protection.js';
import type { WorkspaceProtection } from './protection.js';
import { planProtection } from './protection.js';

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
			planProtection(fixture.host, {
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

function grants(protection: Partial<Protection> = {}): Protection {
	return { readonlyPaths: [], placeholders: [], pins: [], ...protection };
}

it('adds no grants when the whole workspace is read-only', async () => {
	const { run } = plan([git, pathResource('missing')], {
		backend: 'bubblewrap',
		workspaceAccess: 'read-only'
	});

	expect(await run()).toStrictEqual(grants());
});

it.each(['seatbelt', 'bubblewrap'] as const)(
	'protects existing top-level entries with %s',
	async (backend) => {
		const { run } = plan([pathResource('.pi'), pathResource('.envrc')], {
			backend
		});

		expect(await run()).toStrictEqual(
			grants({ readonlyPaths: ['/workspace/.envrc', '/workspace/.pi'] })
		);
	}
);

it.each([
	{
		backend: 'seatbelt',
		expected: new UncoveredProtectedPathError(
			'/workspace/src/index.ts',
			'/workspace/src'
		)
	},
	{
		backend: 'bubblewrap',
		expected: grants({
			readonlyPaths: ['/workspace/src/index.ts'],
			pins: ['/workspace/src']
		})
	}
] as const)(
	'protects a nested path with $backend',
	async ({ backend, expected }) => {
		const { run } = plan([pathResource('src/index.ts')], { backend });

		await (expected instanceof Error
			? expect(run()).rejects.toStrictEqual(expected)
			: expect(run()).resolves.toStrictEqual(expected));
	}
);

it.each([
	{
		backend: 'seatbelt',
		resource: '.idea',
		expected: grants({ readonlyPaths: ['/workspace/.idea'] })
	},
	{
		backend: 'bubblewrap',
		resource: '.idea',
		expected: grants({ placeholders: ['/workspace/.idea'] })
	},
	{
		backend: 'bubblewrap',
		resource: 'src/generated/hooks',
		expected: grants({
			placeholders: ['/workspace/src/generated'],
			pins: ['/workspace/src']
		})
	}
] as const)(
	'covers an absent path $resource with $backend',
	async ({ backend, resource, expected }) => {
		const { run } = plan([pathResource(resource)], { backend });

		expect(await run()).toStrictEqual(expected);
	}
);

it.each([
	{
		backend: 'seatbelt',
		target: '/outside/pi',
		expected: grants({ readonlyPaths: ['/workspace/.pi-link'] })
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

		await (expected instanceof Error
			? expect(run()).rejects.toStrictEqual(expected)
			: expect(run()).resolves.toStrictEqual(expected));
	}
);

it('rejects a symbolic link above a nested path with bubblewrap', async () => {
	const { run, memory } = plan([pathResource('linked/hooks')], {
		backend: 'bubblewrap'
	});

	memory.symlinkSync('/outside', '/workspace/linked');

	await expect(run()).rejects.toStrictEqual(
		new ProtectedSymbolicLinkError('/workspace/linked')
	);
});

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
		expected: grants({ readonlyPaths: ['/workspace/.git'] })
	},
	{
		name: 'a hooks path inside a protected entry',
		output: {
			[gitPaths]: '/workspace/.git\n/workspace/.git\n/workspace/.husky/_\n'
		},
		resources: [git, pathResource('.husky')],
		expected: grants({
			readonlyPaths: ['/workspace/.git', '/workspace/.husky']
		})
	},
	{
		name: 'configuration includes inside the workspace',
		output: {
			...repository,
			[gitIncludes]:
				'file:.git/config\0include.path\n../.gitconfig\0file:.git/config\0includeif.onbranch:x.path\nextra/cfg\0file:/home/user/.gitconfig\0include.path\n~/.gitconfig-work\0'
		},
		resources: [git],
		expected: grants({
			readonlyPaths: ['/workspace/.git', '/workspace/.gitconfig']
		})
	},
	{
		name: 'the pointer file of a linked worktree',
		output: {
			[gitPaths]:
				'/repository/.git/worktrees/w\n/repository/.git\n/repository/.git/hooks\n'
		},
		resources: [git],
		expected: grants({ readonlyPaths: ['/workspace/.git'] })
	}
])('protects Git metadata: $name', async ({ output, resources, expected }) => {
	const { run } = plan(resources, { gitOutput: output });

	expect(await run()).toStrictEqual(expected);
});

it.each([
	{
		backend: 'seatbelt',
		expected: new UncoveredProtectedPathError(
			'/workspace/.husky/_',
			'/workspace/.husky'
		)
	},
	{
		backend: 'bubblewrap',
		expected: grants({
			readonlyPaths: ['/workspace/.git', '/workspace/.husky/_'],
			pins: ['/workspace/.husky']
		})
	}
] as const)(
	'protects a hooks path that Git resolves inside the workspace with $backend',
	async ({ backend, expected }) => {
		const { run } = plan([git], {
			backend,
			gitOutput: {
				[gitPaths]: '/workspace/.git\n/workspace/.git\n/workspace/.husky/_\n'
			}
		});

		await (expected instanceof Error
			? expect(run()).rejects.toStrictEqual(expected)
			: expect(run()).resolves.toStrictEqual(expected));
	}
);

it('reports Git that cannot describe an existing repository', async () => {
	const { run } = plan([git]);
	const cause = new GitCommandError(gitPaths.split(' '), 128, '');

	await expect(run()).rejects.toStrictEqual(
		new GitMetadataUnavailableError(workspace, { cause })
	);
});

it.each([
	{
		hasRepository: false,
		expected: grants({ readonlyPaths: ['/workspace/.git'] })
	},
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

		await (expected instanceof Error
			? expect(run()).rejects.toStrictEqual(expected)
			: expect(run()).resolves.toStrictEqual(expected));
	}
);

it.each([
	{
		backend: 'seatbelt',
		expected: grants({ readonlyPaths: ['/workspace/.git'] })
	},
	{
		backend: 'bubblewrap',
		expected: grants({ placeholders: ['/workspace/.git'] })
	}
] as const)(
	'prevents a new repository outside Git with $backend',
	async ({ backend, expected }) => {
		const { run, memory } = plan([git], { backend });

		memory.rmSync('/workspace/.git', { recursive: true });

		expect(await run()).toStrictEqual(expected);
	}
);
