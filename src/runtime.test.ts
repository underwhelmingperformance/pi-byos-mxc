import path from 'node:path';

import type { SandboxPolicy } from 'pi-bring-your-own-sandbox/provider';
import { expect, it } from 'vitest';

import { validateConfig } from './config.js';
import {
	InvalidPackageManifestError,
	OverlappingPathsError,
	PersonalShellError,
	ShellStartupError,
	UnsupportedRuntimeError
} from './errors.js';
import { memoryHost } from './fixtures/host.js';
import type { HostEnvironment } from './host.js';
import { prepareRuntime } from './runtime.js';

const supervisor = '/runtime/pkg/dist/supervisor/entry.js';

function layout(
	environment: Partial<HostEnvironment> = {},
	linkedLibraries?: Readonly<Record<string, string[]>>
) {
	const fixture = memoryHost(
		{
			'/runtime/pkg/package.json': JSON.stringify({
				dependencies: { direct: '1' },
				peerDependencies: { peer: '1', 'absent-peer': '1' }
			}),
			[supervisor]: '',
			'/runtime/store/direct/node_modules/direct/package.json': JSON.stringify({
				dependencies: { transitive: '1' },
				optionalDependencies: { 'absent-optional': '1' }
			}),
			'/runtime/store/transitive/node_modules/transitive/package.json': '{}',
			'/runtime/node_modules/peer/package.json': '{}',
			'/runtime/node_modules/unrelated/package.json': '{}',
			'/runtime/node/bin/node': '',
			'/bin/dash': '',
			'/bin/bash': '',
			'/tools': {},
			'/workspace/tools': {}
		},
		{
			environment,
			...(linkedLibraries && { linkedLibraries }),
			packages: {
				[supervisor]: { [supervisor]: '/runtime/pkg' },
				'/runtime/pkg/package.json': {
					direct: '/runtime/store/direct/node_modules/direct',
					peer: '/runtime/node_modules/peer'
				},
				'/runtime/store/direct/node_modules/direct/package.json': {
					transitive: '/runtime/store/transitive/node_modules/transitive'
				}
			}
		}
	);
	const { memory } = fixture;

	memory.symlinkSync('/bin/dash', '/bin/sh');
	memory.symlinkSync('/workspace', '/alias');
	memory.chmodSync('/bin/dash', 0o755);
	memory.chmodSync('/bin/bash', 0o755);

	return {
		...fixture,
		prepare: (
			workspace: string,
			settings: unknown = {},
			hostUserData: SandboxPolicy['hostUserData'] = 'denied'
		) =>
			prepareRuntime(workspace, validateConfig(settings), hostUserData, {
				host: fixture.host,
				supervisor
			})
	};
}

it('prepares canonical grants for a separate workspace', async () => {
	const { prepare } = layout();
	const runtime = await prepare('/alias');

	expect({
		...runtime,
		shells: [...runtime.shells]
	}).toStrictEqual({
		entry: supervisor,
		workspace: '/workspace',
		protectedPaths: [
			'/runtime/pkg',
			'/runtime/store/direct/node_modules/direct',
			'/runtime/node_modules/peer',
			'/runtime/store/transitive/node_modules/transitive',
			'/runtime/node/bin/node'
		],
		readonlyPaths: ['/bin/dash', '/bin/bash', '/runtime/node/bin/node'],
		shells: [
			['sh', '/bin/dash'],
			['bash', '/bin/bash']
		],
		backend: 'seatbelt'
	});
});

it.each(['darwin', 'linux'] as const)(
	'refuses a configured home shell in a denied %s profile',
	async (platform) => {
		const { memory, prepare } = layout({ platform });
		const shell = '/home/user/bin/sh';

		memory.mkdirSync(path.dirname(shell), { recursive: true });
		memory.writeFileSync(shell, '#!/bin/sh\n', { mode: 0o755 });

		await expect(
			prepare('/workspace', { shells: { sh: shell } })
		).rejects.toStrictEqual(new PersonalShellError('sh'));
	}
);

it('allows a shell in the home when the profile permits host user data', async () => {
	const { memory, prepare } = layout();
	const shell = '/home/user/bin/sh';

	memory.mkdirSync(path.dirname(shell), { recursive: true });
	memory.writeFileSync(shell, '#!/bin/sh\n', { mode: 0o755 });

	const runtime = await prepare(
		'/workspace',
		{ shells: { sh: shell } },
		'read-only'
	);

	expect([...runtime.shells]).toStrictEqual([
		['sh', shell],
		['bash', '/bin/bash']
	]);
});

it('grants the Node runtime libraries even with a configured target PATH', async () => {
	const packagePath = '/nix/store/arspcb0pa15f9f2b079k1kpqik297fxz-zlib-1.3.2';
	const library = `${packagePath}/lib/libz.dylib`;
	const dependency = '/runtime/lib/libdependency.dylib';
	const { memory, prepare } = layout(
		{},
		{
			'/runtime/node/bin/node': [library, '/usr/lib/libSystem.B.dylib'],
			[library]: [library, dependency],
			[dependency]: [library]
		}
	);

	for (const filename of [library, dependency]) {
		memory.mkdirSync(path.dirname(filename), { recursive: true });
		memory.writeFileSync(filename, '');
	}

	const runtime = await prepare('/workspace', {
		environment: { PATH: '/bin' }
	});

	expect(runtime.readonlyPaths).toStrictEqual([
		'/bin/dash',
		'/bin/bash',
		'/runtime/node/bin/node',
		packagePath,
		dependency
	]);
});

it('rejects a Node runtime library inside the workspace', async () => {
	const library = '/workspace/libnode.dylib';
	const { memory, prepare } = layout(
		{},
		{
			'/runtime/node/bin/node': [library]
		}
	);

	memory.writeFileSync(library, '');

	await expect(prepare('/workspace')).rejects.toStrictEqual(
		new OverlappingPathsError('/workspace', library)
	);
});

it.each([
	{
		name: 'inside the provider package',
		workspace: '/runtime/pkg/work',
		protectedPath: '/runtime/pkg'
	},
	{
		name: 'inside a dependency',
		workspace: '/runtime/store/direct/node_modules/direct/work',
		protectedPath: '/runtime/store/direct/node_modules/direct'
	},
	{
		name: 'inside a dependency of a dependency',
		workspace: '/runtime/store/transitive/node_modules/transitive/work',
		protectedPath: '/runtime/store/transitive/node_modules/transitive'
	},
	{
		name: 'inside a peer',
		workspace: '/runtime/node_modules/peer/work',
		protectedPath: '/runtime/node_modules/peer'
	},
	{
		name: 'containing the Node executable',
		workspace: '/runtime/node',
		protectedPath: '/runtime/node/bin/node'
	}
])('rejects a workspace $name', async ({ workspace, protectedPath }) => {
	const { prepare, memory } = layout();

	memory.mkdirSync(workspace, { recursive: true });

	await expect(prepare(workspace)).rejects.toStrictEqual(
		new OverlappingPathsError(workspace, protectedPath)
	);
});

it('does not protect an installed package outside the dependency graph', async () => {
	const { prepare } = layout();

	await expect(
		prepare('/runtime/node_modules/unrelated')
	).resolves.toMatchObject({ workspace: '/runtime/node_modules/unrelated' });
});

it('rejects a configured shell inside the workspace', async () => {
	const { prepare, memory } = layout();

	memory.writeFileSync('/workspace/sh', '#!/bin/sh\n', { mode: 0o755 });

	await expect(
		prepare('/workspace', { shells: { sh: '/workspace/sh' } })
	).rejects.toStrictEqual(
		new OverlappingPathsError('/workspace', '/workspace/sh')
	);
});

it('fails startup when the configured Bash is not executable', async () => {
	const { prepare, memory } = layout();

	memory.chmodSync('/bin/bash', 0o644);

	await expect(prepare('/workspace')).rejects.toMatchObject({
		name: 'ShellStartupError',
		message: new ShellStartupError('bash').message
	});
});

it.each([
	{ nodeVersion: '22.12.0', arch: 'arm64' },
	{ nodeVersion: '24.22.2', arch: 'x64' }
] as const)(
	'rejects an unsupported runtime: Node $nodeVersion on $arch',
	async (environment) => {
		const { prepare } = layout(environment);

		await expect(prepare('/workspace')).rejects.toStrictEqual(
			new UnsupportedRuntimeError(
				environment.nodeVersion,
				'darwin',
				environment.arch
			)
		);
	}
);

it('rejects a dependency manifest with invalid dependency fields', async () => {
	const { prepare, memory } = layout();

	memory.writeFileSync(
		'/runtime/store/direct/node_modules/direct/package.json',
		'{"dependencies":["transitive"]}'
	);

	await expect(prepare('/workspace')).rejects.toStrictEqual(
		new InvalidPackageManifestError('/runtime/store/direct/node_modules/direct')
	);
});
