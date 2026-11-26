import { execFile } from 'node:child_process';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
	ProcessRequest,
	SandboxCopySource,
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/provider';
import {
	isSandboxError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError
} from 'pi-bring-your-own-sandbox/provider';
import type { SandboxProviderFixtureOptions } from 'pi-bring-your-own-sandbox/testing';
import { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';
import { assert, expect } from 'vitest';

import { MxcBackend } from './backend.js';
import type { MxcConfig } from './config.js';
import {
	startDescendant,
	verifyDescendantStopped
} from './fixtures/descendant-lock.js';
import { defaultPolicy } from './fixtures/profiles.js';
import type { Host } from './host.js';
import { systemHost } from './host.js';
import { createProvider } from './provider.js';
import { quote } from './shell.js';
import type { JobAllocation } from './supervisor/client.js';
import { SupervisorJob } from './supervisor/client.js';

const provider = createProvider();
const allocations = new Map<string, Set<string>>();
const jobs = new Map<string, Map<string, JobAllocation>>();
const targets = new Map<string, { root: string; home: string }>();
const execute = promisify(execFile);

async function observedOpen(
	host: Host,
	request: SandboxOpenRequest<MxcConfig>,
	context: SandboxOpenContext,
	source?: SandboxCopySource
) {
	const backend = await MxcBackend.open(
		request,
		{
			...context,
			reportRecovery(recovery) {
				context.reportRecovery(recovery);

				if (recovery.kind === 'allocation') {
					allocations
						.get(request.hostWorkspace)
						?.add(path.join(tmpdir(), `pi-byos-mxc-${recovery.id}`));
				}
			}
		},
		{
			host,
			createJob(options) {
				return new SupervisorJob({
					...options,
					record(allocation) {
						jobs.get(request.hostWorkspace)?.set(allocation.id, allocation);

						return options.record(allocation);
					}
				});
			}
		},
		source
	);

	if (!targets.has(request.hostWorkspace)) {
		const { root, home } = backend.workspace;

		assert.isDefined(home);
		targets.set(request.hostWorkspace, { root, home });
	}

	return backend;
}

function testedProvider(): SandboxProvider<MxcConfig> {
	const host = {
		...systemHost,
		environment: { ...systemHost.environment, homeDirectory: homedir() }
	};

	return {
		...provider,
		open: (request, context) => observedOpen(host, request, context),
		...(provider.copy !== undefined && {
			copy: (request, context) =>
				observedOpen(host, request, context, request.source)
		})
	};
}

function targetFor(workspace: string) {
	const target = targets.get(workspace);

	assert.isDefined(target);

	return target;
}

function isDenied(error: unknown): boolean {
	return (
		isSandboxError(error, SandboxPermissionDeniedError) ||
		isSandboxError(error, SandboxPathNotFoundError)
	);
}

async function verifyOwnedProcesses(workspace: string): Promise<void> {
	const seen = jobs.get(workspace);

	assert.isDefined(seen);
	expect(seen.size).not.toBe(0);

	const supervisors = new Set(seen.values().map((job) => job.supervisorPid));
	const groups = new Set(
		seen
			.values()
			.map((job) => job.targetPid)
			.filter((id) => id !== undefined)
	);
	const snapshot = await execute('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
		timeout: 1000,
		maxBuffer: 2_097_152
	});
	const alive = snapshot.stdout
		.trim()
		.split('\n')
		.map((line) => line.trim().split(/\s+/u))
		.filter(
			([pid, group, status]) =>
				supervisors.has(Number(pid)) ||
				(groups.has(Number(group)) && !status?.startsWith('Z'))
		);

	expect(alive).toStrictEqual([]);
}

async function verifyStopped(workspace: string): Promise<void> {
	await verifyOwnedProcesses(workspace);

	await verifyDescendantStopped(targetFor(workspace).home);
}

function shell(command: string): ProcessRequest {
	return {
		kind: 'shell',
		dialect: 'sh',
		command
	};
}

const suite: SandboxProviderFixtureOptions<MxcConfig> = {
	label: `MXC ${process.platform}/${process.arch} declared profiles`,
	timeoutMs: 20_000,
	cleanup: { cancellationGraceMs: 10_000, disposalTimeoutMs: 15_000 },
	async createFixture(selection) {
		const policy = selection?.profile.policy ?? defaultPolicy;
		const temporary = await mkdtemp(
			path.join(tmpdir(), 'pi-byos-mxc-contract-')
		);
		const root = await realpath(temporary);
		const workspace = path.join(root, 'workspace');
		const outside = path.join(root, 'outside');

		await mkdir(workspace);
		await writeFile(outside, 'host-only');

		const resources = new Set<string>();
		const probe = {
			exit: { kind: 'code', code: 7 },
			stdout: new Uint8Array([0, 255, 10]),
			stderr: new TextEncoder().encode('error')
		} as const;
		const command = "printf '\\000\\377\\012'; printf error >&2; exit 7";

		const seeded = path.join(workspace, 'seeded');
		const data = Uint8Array.of(0, 255, 10);

		await mkdir(seeded);
		await writeFile(path.join(seeded, 'data'), data);

		const searchRoot = 'search';
		const searchDirectory = path.join(workspace, searchRoot);

		await mkdir(searchDirectory);
		await writeFile(
			path.join(searchDirectory, 'notes.txt'),
			'first\nnEedle.\nlast\n'
		);
		await writeFile(path.join(searchDirectory, 'other.txt'), 'NEEDLE.\n');

		const first = {
			path: 'notes.txt',
			line: 2,
			text: 'nEedle.',
			before: ['first'],
			after: ['last']
		};
		const second = {
			path: 'other.txt',
			line: 1,
			text: 'NEEDLE.',
			before: [],
			after: []
		};
		const query = {
			path: searchRoot,
			pattern: 'needle.',
			literal: true,
			ignoreCase: true,
			glob: '*.txt',
			context: 1
		};
		const directory = 'new/nested';
		const destination =
			selection?.mode === 'open' && !policy.hostWorkspaceWrites
				? 'seeded/data'
				: path.join(directory, 'file');

		allocations.set(workspace, resources);
		jobs.set(workspace, new Map());

		return {
			provider: testedProvider(),
			configuration: {},
			find: [
				{
					request: { path: searchRoot, pattern: '*.txt', limit: 2 },
					result: { paths: ['notes.txt', 'other.txt'], truncated: false }
				},
				{
					request: { path: searchRoot, pattern: '*.txt', limit: 1 },
					result: { paths: ['notes.txt'], truncated: true }
				}
			],
			grep: [
				{
					request: { ...query, limit: 2 },
					result: { matches: [first, second], truncated: false }
				},
				{
					request: { ...query, limit: 1 },
					result: { matches: [first], truncated: true }
				}
			],
			read: {
				path: 'seeded/data',
				bytes: data,
				missingPath: 'seeded/missing'
			},
			write: {
				directory,
				path: destination,
				async read() {
					const filename = path.join(targetFor(workspace).root, destination);

					return new Uint8Array(await readFile(filename));
				}
			},
			list: {
				path: 'seeded',
				async stat() {
					const metadata = await stat(
						path.join(targetFor(workspace).root, 'seeded')
					);

					return { kind: 'directory', size: metadata.size };
				},
				entries: [{ name: 'data', kind: 'file' }]
			},
			hostWorkspace: workspace,
			policy,
			processes: [
				{
					request: {
						kind: 'argv',
						executable: '/bin/sh',
						args: [
							'-c',
							'printf "%s:%s:" "$MXC_PROBE" "$1"; cat data; exit 127',
							'probe',
							"literal '$(exit 9)'"
						],
						cwd: 'seeded',
						env: { MXC_PROBE: 'target' }
					},
					exit: { kind: 'code', code: 127 },
					stdout: new Uint8Array(
						Buffer.concat([Buffer.from("target:literal '$(exit 9)':"), data])
					),
					stderr: new Uint8Array()
				}
			],
			shells: {
				sh: { ...probe, request: { kind: 'shell', dialect: 'sh', command } },
				bash: { ...probe, request: { kind: 'shell', dialect: 'bash', command } }
			},
			cancellation: {
				request: {
					kind: 'shell',
					dialect: 'sh',
					command: `cd "$HOME" || exit 1; ${startDescendant('')}; printf ready; wait "$child"`
				},
				ready: new TextEncoder().encode('ready'),
				verifyStopped: () => verifyStopped(workspace)
			},
			async verifyPolicy(backend, context) {
				const alias = path.join(backend.workspace.root, 'outside-alias');

				await symlink(outside, alias);
				await expect(
					backend.files?.write?.writeFile(
						alias,
						Buffer.from('changed'),
						context
					)
				).rejects.toSatisfy(isDenied);

				if (policy.hostUserData === 'denied') {
					await expect(
						backend.files?.read?.readFile(alias, context)
					).rejects.toSatisfy(isDenied);
				}

				expect(await readFile(outside, 'utf8')).toBe('host-only');

				const output: Uint8Array[] = [];
				const result = await backend.exec(
					shell(
						`cat /etc/hosts >/dev/null && printf system; cat ${quote(outside)} 2>/dev/null; true`
					),
					{
						...context,
						onOutput(chunk) {
							if (chunk.stream === 'stdout') {
								output.push(chunk.data);
							}
						}
					}
				);

				expect({
					result,
					output: Buffer.concat(output).toString()
				}).toStrictEqual({
					result: { kind: 'exited', exit: { kind: 'code', code: 0 } },
					output:
						policy.hostUserData === 'denied' ? 'system' : 'systemhost-only'
				});
			},
			async verifyDisposed(backend, recovery) {
				if (backend === undefined && recovery?.kind === 'none') {
					expect({
						resources: [...resources],
						jobs: jobs.get(workspace)?.size
					}).toStrictEqual({ resources: [], jobs: 0 });

					return;
				}

				await verifyOwnedProcesses(workspace);

				for (const resource of resources) {
					await expect(access(resource)).rejects.toMatchObject({
						code: 'ENOENT'
					});
				}
			},
			async cleanup() {
				const remaining: string[] = [];

				for (const resource of resources) {
					try {
						await access(resource);
						remaining.push(resource);
					} catch (error) {
						if (!(
							error instanceof Error &&
							'code' in error &&
							error.code === 'ENOENT'
						)) {
							throw error;
						}
					}
				}

				// Leave unconfirmed native resources in place for inspection.
				expect(remaining).toStrictEqual([]);
				allocations.delete(workspace);
				jobs.delete(workspace);
				targets.delete(workspace);
				await rm(root, { recursive: true, force: true });
			}
		};
	}
};

defineSandboxProviderTests(suite);
