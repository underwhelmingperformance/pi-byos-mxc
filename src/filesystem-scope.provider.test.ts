import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import type {
	SandboxBackend,
	SandboxCopySource,
	SandboxOpenContext,
	SandboxOpenRequest
} from 'pi-bring-your-own-sandbox/provider';
import {
	SandboxPermissionDeniedError,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/provider';
import { assert, expect, it, vi } from 'vitest';

import { MxcBackend } from './backend.js';
import type { MxcConfig } from './config.js';
import { validateConfig } from './config.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { withNativeSandbox } from './fixtures/native-sandbox.js';
import { fixtureProfile } from './fixtures/profiles.js';
import { systemHost } from './host.js';
import { profilesFor } from './policy.js';
import { quote } from './shell.js';

it('reads system files but cannot discover or read a private home entry', async () => {
	const directory = await mkdtemp(path.join(homedir(), '.mxc-test-'));
	const file = path.join(directory, 'canary');

	try {
		await writeFile(file, 'private');
		await withNativeSandbox({}, async (sandbox) => {
			const result = await sandbox.exec({
				kind: 'shell',
				dialect: 'sh',
				command: `cat /etc/hosts >/dev/null && printf system; cat ${quote(file)} 2>/dev/null; ls -A ${quote(directory)} 2>/dev/null; ls -A ${quote(homedir())} 2>/dev/null | grep -Fx ${quote(path.basename(directory))}; true`
			});

			expect({
				scope: sandbox.policy.hostUserData,
				stdout: new TextDecoder().decode(result.stdout)
			}).toStrictEqual({ scope: 'denied', stdout: 'system' });
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function withFixtureHome(
	check: (fixture: {
		home: string;
		request: SandboxOpenRequest<MxcConfig>;
		context: SandboxOpenContext & {
			reportDiagnostic: ReturnType<typeof vi.fn>;
		};
		open: (
			request: SandboxOpenRequest<MxcConfig>,
			source?: SandboxCopySource
		) => Promise<SandboxBackend>;
	}) => Promise<void>
) {
	const temporary = await mkdtemp(path.join(tmpdir(), 'mxc-host-data-'));
	const directory = await realpath(temporary);
	const home = path.join(directory, 'home');
	const workspace = path.join(directory, 'workspace');
	const context = {
		operationId: 'host-data',
		signal: new AbortController().signal,
		deadline: Date.now() + 15_000,
		remainingMs: () => 15_000,
		cleanup: cleanupControl().cleanup,
		reportRecovery: vi.fn(),
		reportDiagnostic: vi.fn(),
		confirmCleanup: vi.fn()
	};
	const host = {
		...systemHost,
		environment: { ...systemHost.environment, homeDirectory: home }
	};
	const allocated: SandboxBackend[] = [];
	const request = {
		generationId: 'host-data',
		sessionId: 'test',
		hostWorkspace: workspace,
		profile: fixtureProfile(),
		configuration: validateConfig({})
	};

	try {
		await mkdir(home);
		await mkdir(workspace);
		await check({
			home,
			request,
			context,
			async open(options, source) {
				const backend = await MxcBackend.open(
					options,
					context,
					{ host },
					source
				);

				allocated.push(backend);

				return backend;
			}
		});
	} finally {
		try {
			await Promise.all(allocated.map((backend) => backend.dispose(context)));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}

async function run(
	backend: SandboxBackend,
	command: string,
	context: SandboxOpenContext
) {
	const chunks: Uint8Array[] = [];
	const result = await backend.exec(
		{ kind: 'shell', dialect: 'sh', command },
		{
			...context,
			onOutput(chunk) {
				if (chunk.stream === 'stdout') {
					chunks.push(chunk.data);
				}
			}
		}
	);

	return { result, stdout: Buffer.concat(chunks).toString() };
}

it.runIf(process.platform === 'darwin').each([false, true])(
	'denies host credential reads with network %s including a late path',
	async (network) => {
		await withFixtureHome(async ({ home, request, context, open }) => {
			const ordinary = path.join(home, 'ordinary');
			const ssh = path.join(home, '.ssh', 'marker');
			const aws = path.join(home, '.aws', 'marker');

			await mkdir(path.dirname(ssh));
			await writeFile(ordinary, 'ordinary');
			await writeFile(ssh, 'private ssh');

			const backend = await open({
				...request,
				profile: fixtureProfile({ network, hostUserData: 'read-only' })
			});

			await mkdir(path.dirname(aws));
			await writeFile(aws, 'private aws');

			const reads = backend.files?.read;

			assert(reads);

			const shell = await run(
				backend,
				`cat ${quote(ordinary)}; cat ${quote(ssh)} ${quote(aws)} 2>/dev/null; true`,
				context
			);

			expect({
				shell,
				file: Buffer.from(await reads.readFile(ordinary, context)).toString()
			}).toStrictEqual({
				shell: {
					result: { kind: 'exited', exit: { kind: 'code', code: 0 } },
					stdout: 'ordinary'
				},
				file: 'ordinary'
			});

			for (const file of [ssh, aws]) {
				await expect(reads.readFile(file, context)).rejects.toHaveProperty(
					'name',
					expect.stringMatching(
						/^Sandbox(?:PathNotFound|PermissionDenied)Error$/u
					)
				);
			}
		});
	}
);

it.runIf(process.platform === 'darwin')(
	'refuses writes to ordinary and credential files with read-only host user data',
	async () => {
		await withFixtureHome(async ({ home, request, context, open }) => {
			const ordinary = path.join(home, 'ordinary');
			const credential = path.join(home, '.ssh/marker');

			await mkdir(path.dirname(credential));
			await Promise.all([
				writeFile(ordinary, 'ordinary'),
				writeFile(credential, 'credential')
			]);

			const backend = await open({
				...request,
				profile: fixtureProfile({ network: true, hostUserData: 'read-only' })
			});
			const writer = backend.files?.write;

			assert.isDefined(writer);

			for (const filename of [ordinary, credential]) {
				await expect(
					writer.writeFile(filename, Buffer.from('changed'), context)
				).rejects.toBeInstanceOf(SandboxPermissionDeniedError);
			}

			expect(
				await Promise.all([
					readFile(ordinary, 'utf8'),
					readFile(credential, 'utf8')
				])
			).toStrictEqual(['ordinary', 'credential']);
		});
	}
);

it('maps exact read and write grants under the private home', async () => {
	await withFixtureHome(async ({ home, request, context, open }) => {
		const readable = path.join(home, 'readable');
		const writable = path.join(home, 'writable');
		const excluded = path.join(home, 'excluded');

		await Promise.all([
			writeFile(readable, 'read'),
			writeFile(writable, 'initial'),
			writeFile(excluded, 'excluded')
		]);

		const backend = await open({
			...request,
			paths: { read: [readable], write: [writable] }
		});
		const targetHome = backend.workspace.home;

		assert(targetHome);

		const shell = await run(
			backend,
			'cat "$HOME/readable"; printf write > "$HOME/writable"; printf bad > "$HOME/readable"; true',
			context
		);
		const outside = await run(
			backend,
			`cat ${quote(excluded)} 2>/dev/null; printf bad > ${quote(excluded)} 2>/dev/null; true`,
			context
		);

		expect({
			shell,
			outside,
			readable: await readFile(readable, 'utf8'),
			writable: await readFile(writable, 'utf8'),
			excluded: await readFile(excluded, 'utf8'),
			grants: backend.grantedPaths
		}).toStrictEqual({
			shell: {
				result: { kind: 'exited', exit: { kind: 'code', code: 0 } },
				stdout: 'read'
			},
			outside: {
				result: { kind: 'exited', exit: { kind: 'code', code: 0 } },
				stdout: ''
			},
			readable: 'read',
			writable: 'write',
			excluded: 'excluded',
			grants: [
				{
					kind: 'read',
					hostPath: readable,
					targetPath: path.join(targetHome, 'readable')
				},
				{
					kind: 'write',
					hostPath: writable,
					targetPath: path.join(targetHome, 'writable')
				}
			]
		});
	});
});

it.runIf(process.platform === 'darwin').each([
	{ network: false, hostUserData: 'read-only' },
	{ network: true, hostUserData: 'denied' }
] as const)(
	'exposes only the approved credential file with network $network and host user data $hostUserData',
	async ({ network, hostUserData }) => {
		await withFixtureHome(async ({ home, request, context, open }) => {
			const approved = path.join(home, '.ssh', 'approved');
			const sibling = path.join(home, '.ssh', 'sibling');
			const aws = path.join(home, '.aws', 'marker');

			await mkdir(path.dirname(approved));
			await mkdir(path.dirname(aws));
			await writeFile(approved, 'approved');
			await writeFile(sibling, 'private ssh');
			await writeFile(aws, 'private aws');

			const backend = await open({
				...request,
				profile: fixtureProfile({ network, hostUserData }),
				paths: { read: [approved] }
			});
			const targetHome = backend.workspace.home;
			const reads = backend.files?.read;

			assert(targetHome);
			assert(reads);

			const target = path.join(targetHome, '.ssh', 'approved');
			const shell = await run(
				backend,
				`cat "$HOME/.ssh/approved"; cat ${quote(sibling)} ${quote(aws)} 2>/dev/null; true`,
				context
			);

			expect({
				shell,
				file: Buffer.from(await reads.readFile(target, context)).toString(),
				grants: backend.grantedPaths
			}).toStrictEqual({
				shell: {
					result: { kind: 'exited', exit: { kind: 'code', code: 0 } },
					stdout: 'approved'
				},
				file: 'approved',
				grants: [{ kind: 'read', hostPath: approved, targetPath: target }]
			});

			for (const file of [sibling, aws]) {
				await expect(reads.readFile(file, context)).rejects.toHaveProperty(
					'name',
					'SandboxPermissionDeniedError'
				);
			}
		});
	}
);

it.runIf(process.platform === 'darwin').each(['read', 'write'] as const)(
	'refuses an open-egress credential %s grant with a path diagnostic',
	async (kind) => {
		await withFixtureHome(async ({ home, request, context, open }) => {
			const credential = path.join(home, '.ssh', 'marker');

			await expect(
				open({
					...request,
					profile: fixtureProfile({ network: true, hostUserData: 'read-only' }),
					paths: { [kind]: [credential] }
				})
			).rejects.toStrictEqual(
				new UnsupportedSandboxPolicyError({
					operation: 'open',
					providerId: 'mxc',
					detail: {
						kind: 'path',
						path: credential,
						access: kind,
						reason: 'unreachable'
					}
				})
			);
			expect(context.reportDiagnostic.mock.calls).toStrictEqual([
				[
					{
						level: 'warning',
						message:
							'The macOS open-egress profile cannot grant one credential path while keeping its directory protected.'
					}
				]
			]);
		});
	}
);

const devices = [
	'/dev/null',
	'/dev/zero',
	'/dev/random',
	'/dev/urandom',
	'/dev/stdout',
	'/dev/stderr',
	'/dev/fd/2',
	'/dev/fd/3'
];
const redirectionProbe = devices
	.map(
		(device) =>
			`/bin/sh -c ${quote(`: > ${device}`)} 3>&2; printf '%s=%s\n' ${device} "$?"`
	)
	.join('; ');
const macProfiles = profilesFor('darwin');

it
	.runIf(process.platform === 'darwin')
	.each([
		...macProfiles.open.map(
			(profile) => ({ operation: 'open', profile }) as const
		),
		...macProfiles.copy.map(
			(profile) => ({ operation: 'copy', profile }) as const
		)
	])(
	'supports device redirection and writable directories in macOS $operation with network $profile.policy.network, user data $profile.policy.hostUserData and host workspace writes $profile.policy.hostWorkspaceWrites',
	async ({ operation, profile }) => {
		await withFixtureHome(async ({ request, context, open }) => {
			const source =
				operation === 'copy' ? ({ kind: 'host' } as const) : undefined;
			const backend = await open({ ...request, profile }, source);
			const isWritable =
				source !== undefined || profile.policy.hostWorkspaceWrites;
			const scratch = backend.workspace.home;

			assert(scratch);

			const redirections = await run(backend, redirectionProbe, context);
			const readOnlyDescriptor = await run(
				backend,
				"/bin/sh -c ': > /dev/fd/3' 3</dev/null",
				context
			);
			const inherited = await run(
				backend,
				'printf stdout >&1 && printf stderr >&2',
				context
			);
			const homeWrite = await run(
				backend,
				'printf scratch > "$HOME/home-probe"',
				context
			);
			const homeContents = await readFile(
				path.join(scratch, 'home-probe'),
				'utf8'
			);
			const write = isWritable
				? await run(backend, 'printf written > workspace-probe', context)
				: undefined;
			const contents = isWritable
				? await readFile(
						path.join(backend.workspace.root, 'workspace-probe'),
						'utf8'
					)
				: undefined;
			const succeeded = {
				result: { kind: 'exited', exit: { kind: 'code', code: 0 } },
				stdout: ''
			};
			const deviceResults = profile.policy.network
				? [0, 0, 0, 0, 0, 0, 0, 0]
				: [0, 1, 1, 1, 0, 0, 0, 0];

			expect({
				redirections,
				readOnlyDescriptor,
				inherited,
				homeWrite,
				homeContents,
				write,
				contents
			}).toStrictEqual({
				redirections: {
					...succeeded,
					stdout: devices
						.map(
							(device, index) => `${device}=${String(deviceResults[index])}\n`
						)
						.join('')
				},
				readOnlyDescriptor: {
					result: { kind: 'exited', exit: { kind: 'code', code: 1 } },
					stdout: ''
				},
				inherited: { ...succeeded, stdout: 'stdout' },
				homeWrite: succeeded,
				homeContents: 'scratch',
				write: isWritable ? succeeded : undefined,
				contents: isWritable ? 'written' : undefined
			});
		});
	}
);
