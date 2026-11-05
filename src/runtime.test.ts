import type { SandboxDiagnostic } from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { validateConfig } from './config.js';
import {
	InvalidPackageManifestError,
	OverlappingPathsError,
	UnsupportedRuntimeError
} from './errors.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { memoryHost } from './fixtures/host.js';
import type { HostEnvironment } from './host.js';
import { prepareRuntime } from './runtime.js';

const supervisor = '/runtime/pkg/dist/supervisor/entry.js';

function layout(environment: Partial<HostEnvironment> = {}) {
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

	const diagnostics: SandboxDiagnostic[] = [];
	const context = {
		operationId: 'runtime',
		signal: new AbortController().signal,
		deadline: 1000,
		remainingMs: () => 10_000,
		cleanup: cleanupControl().cleanup,
		reportDiagnostic(diagnostic: SandboxDiagnostic) {
			diagnostics.push(diagnostic);
		},
		reportRecovery() {
			return;
		},
		confirmCleanup() {
			return;
		}
	};

	return {
		...fixture,
		diagnostics,
		prepare: (workspace: string, settings: unknown = {}) =>
			prepareRuntime(workspace, validateConfig(settings), context, {
				host: fixture.host,
				supervisor
			})
	};
}

it('prepares canonical grants for a separate workspace', async () => {
	const { prepare, diagnostics } = layout();
	const runtime = await prepare('/alias', { readonlyPaths: ['/tools'] });

	expect({
		...runtime,
		shells: [...runtime.shells],
		diagnostics
	}).toStrictEqual({
		entry: supervisor,
		workspace: '/workspace',
		readonlyPaths: ['/tools', '/bin/dash', '/bin/bash'],
		configuredPaths: ['/tools', '/bin/dash', '/bin/bash'],
		shells: [
			['sh', '/bin/dash'],
			['bash', '/bin/bash']
		],
		backend: 'seatbelt',
		diagnostics: []
	});
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

it.each([
	{ name: 'a read-only grant inside it', grant: '/workspace/tools' },
	{ name: 'a read-only grant containing it', grant: '/' },
	{ name: 'a read-only grant through a symlink alias', grant: '/alias' }
])('rejects a workspace that overlaps $name', async ({ grant }) => {
	const { prepare, host } = layout();
	const granted = await host.fs.realpath(grant);

	await expect(
		prepare('/workspace', { readonlyPaths: [grant] })
	).rejects.toStrictEqual(new OverlappingPathsError('/workspace', granted));
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

it('offers sh only when the configured Bash is not executable', async () => {
	const { prepare, memory, diagnostics } = layout();

	memory.chmodSync('/bin/bash', 0o644);

	const runtime = await prepare('/workspace');

	expect({ shells: [...runtime.shells], diagnostics }).toStrictEqual({
		shells: [['sh', '/bin/dash']],
		diagnostics: [
			{
				level: 'warning',
				message:
					'The configured Bash executable is unavailable. MXC will offer sh only.'
			}
		]
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

it('reports configured grants at their canonical targets', async () => {
	const { prepare, memory } = layout();

	memory.mkdirSync('/home/user/tool', { recursive: true });
	memory.mkdirSync('/opt');
	memory.symlinkSync('/home/user/tool', '/opt/tool');

	const runtime = await prepare('/workspace', { readonlyPaths: ['/opt/tool'] });

	expect(runtime.configuredPaths).toStrictEqual([
		'/home/user/tool',
		'/bin/dash',
		'/bin/bash'
	]);
});
