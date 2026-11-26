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
	SandboxOpenContext,
	SandboxOpenRequest
} from 'pi-bring-your-own-sandbox/provider';
import { UnsupportedSandboxPolicyError } from 'pi-bring-your-own-sandbox/provider';
import { assert, expect, it, vi } from 'vitest';

import { MxcBackend } from './backend.js';
import type { MxcConfig } from './config.js';
import { validateConfig } from './config.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { withNativeSandbox } from './fixtures/native-sandbox.js';
import { fixtureProfile } from './fixtures/profiles.js';
import { systemHost } from './host.js';
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
		open: (request: SandboxOpenRequest<MxcConfig>) => Promise<SandboxBackend>;
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
			async open(options) {
				const backend = await MxcBackend.open(options, context, { host });

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

it.each(['read', 'write'] as const)(
	'refuses a credential %s grant with a path diagnostic',
	async (kind) => {
		await withFixtureHome(async ({ home, request, context, open }) => {
			const credential = path.join(home, '.ssh', 'marker');

			await expect(
				open({
					...request,
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
						message: 'MXC cannot grant access to credential locations.'
					}
				]
			]);
		});
	}
);
