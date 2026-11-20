import { execFile } from 'node:child_process';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SandboxProvider } from 'pi-bring-your-own-sandbox/api';
import { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';
import { assert, expect } from 'vitest';

import { MxcBackend } from './backend.js';
import type { MxcConfig } from './config.js';
import {
	startDescendant,
	verifyDescendantStopped
} from './fixtures/descendant-lock.js';
import { EFFECTIVE_POLICY } from './policy.js';
import { provider } from './provider.js';
import { prepareRuntime } from './runtime.js';
import type { JobAllocation } from './supervisor/client.js';
import { SupervisorJob } from './supervisor/client.js';

const allocations = new Map<string, Set<string>>();
const jobs = new Map<string, Map<string, JobAllocation>>();
const execute = promisify(execFile);
const testedProvider: SandboxProvider<MxcConfig> = {
	...provider,
	open(request, context) {
		return MxcBackend.open(
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
				prepareRuntime,
				createJob(options) {
					return new SupervisorJob({
						...options,
						record(allocation) {
							jobs.get(request.hostWorkspace)?.set(allocation.id, allocation);

							return options.record(allocation);
						}
					});
				}
			}
		);
	}
};

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

	await verifyDescendantStopped(workspace);
}

defineSandboxProviderTests({
	label: `MXC ${process.platform}/${process.arch} shared workspace`,
	provider: testedProvider,
	timeoutMs: 20_000,
	cleanup: { cancellationGraceMs: 10_000, disposalTimeoutMs: 15_000 },
	async createFixture() {
		const temporary = await mkdtemp(
			path.join(tmpdir(), 'pi-byos-mxc-contract-')
		);
		const workspace = await realpath(temporary);
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

		const searchRoot = path.join(workspace, 'search');

		await mkdir(searchRoot);
		await writeFile(
			path.join(searchRoot, 'notes.txt'),
			'first\nnEedle.\nlast\n'
		);
		await writeFile(path.join(searchRoot, 'other.txt'), 'NEEDLE.\n');

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
		const metadata = await stat(seeded);
		const directory = path.join(workspace, 'new', 'nested');
		const destination = path.join(directory, 'file');

		allocations.set(workspace, resources);
		jobs.set(workspace, new Map());

		return {
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
				path: path.join(seeded, 'data'),
				bytes: data,
				missingPath: path.join(seeded, 'missing')
			},
			write: {
				directory,
				path: destination,
				read: async () => new Uint8Array(await readFile(destination))
			},
			list: {
				path: seeded,
				stat: { kind: 'directory', size: metadata.size },
				entries: [{ name: 'data', kind: 'file' }]
			},
			hostWorkspace: workspace,
			policy: EFFECTIVE_POLICY,
			shells: {
				sh: { ...probe, request: { kind: 'shell', dialect: 'sh', command } },
				bash: { ...probe, request: { kind: 'shell', dialect: 'bash', command } }
			},
			cancellation: {
				request: {
					kind: 'shell',
					dialect: 'sh',
					command: `${startDescendant('')}; printf ready; wait "$child"`
				},
				ready: new TextEncoder().encode('ready'),
				verifyStopped: () => verifyStopped(workspace)
			},
			async verifyDisposed() {
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
				await rm(workspace, { recursive: true, force: true });
			}
		};
	}
});
