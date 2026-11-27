import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
	access,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { SandboxOpenContext } from 'pi-bring-your-own-sandbox/provider';
import { defaultProtectedWorkspacePaths } from 'pi-bring-your-own-sandbox/provider';
import { assert, expect, it } from 'vitest';

import { MxcBackend } from './backend.js';
import { validateConfig } from './config.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { nodeCommand } from './fixtures/native-sandbox.js';
import { fixtureProfile } from './fixtures/profiles.js';
import { compareText } from './paths.js';
import { prepareRuntime } from './runtime.js';
import type { JobAllocation } from './supervisor/client.js';
import { SupervisorJob } from './supervisor/client.js';

const execute = promisify(execFile);

async function groupMembers(
	jobs: ReadonlyMap<string, JobAllocation>
): Promise<string[]> {
	const groups = new Set(
		jobs
			.values()
			.map((job) => job.targetPid)
			.filter((id) => id !== undefined)
	);
	const snapshot = await execute('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
		timeout: 1000,
		maxBuffer: 2_097_152
	});

	return snapshot.stdout
		.trim()
		.split('\n')
		.filter((line) => {
			const [, group, state] = line.trim().split(/\s+/u, 3);

			return groups.has(Number(group)) && !state?.startsWith('Z');
		});
}

async function waitForGroups(
	jobs: ReadonlyMap<string, JobAllocation>
): Promise<void> {
	const deadline = performance.now() + 8000;

	while (performance.now() < deadline) {
		const members = await groupMembers(jobs);

		if (members.length === 0) {
			return;
		}

		await delay(50);
	}

	expect(await groupMembers(jobs)).toStrictEqual([]);
}

it('retains recovery after hard supervisor death even when the platform stops the group', async () => {
	const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-mxc-crash-'));
	const workspace = await realpath(temporary);
	const release = path.join(workspace, 'release');
	const effect = path.join(workspace, 'effect');
	const workloadLifetimeMs = 5000;
	const command = nodeCommand(
		`const fs=require('node:fs');const deadline=Date.now()+${String(workloadLifetimeMs)};console.log('owned-ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(effect)},'continued');clearInterval(timer);process.exit(0);}if(Date.now()>=deadline){clearInterval(timer);process.exit(0);}},25);`
	);
	const allocations = new Set<string>();
	const jobs = new Map<string, JobAllocation>();
	const helpers: ChildProcess[] = [];
	let didKill = false;
	let finiteDeadline = 0;
	let crashed: JobAllocation | undefined;
	const failures: unknown[] = [];
	const context: SandboxOpenContext = {
		operationId: randomUUID(),
		deadline: Date.now() + 15_000,
		remainingMs: () => 15_000,
		signal: new AbortController().signal,
		cleanup: cleanupControl().cleanup,
		reportRecovery(recovery) {
			if (recovery.kind === 'allocation') {
				allocations.add(path.join(tmpdir(), `pi-byos-mxc-${recovery.id}`));
			}
		},
		confirmCleanup() {
			return;
		},
		reportDiagnostic() {
			return;
		}
	};

	try {
		const backend = await MxcBackend.open(
			{
				generationId: randomUUID(),
				sessionId: 'crash-test',
				hostWorkspace: workspace,
				profile: fixtureProfile(),
				configuration: validateConfig({})
			},
			context,
			{
				prepareRuntime,
				createJob(options) {
					let helper: ChildProcess | undefined;
					let output = '';

					return new SupervisorJob({
						...options,
						spawn(executable, childArguments, settings) {
							helper = spawn(executable, childArguments, settings);
							helpers.push(helper);

							return helper;
						},
						record(allocation) {
							jobs.set(allocation.id, allocation);

							if (options.request.command === command) {
								crashed = allocation;
							}

							return options.record(allocation);
						},
						context: {
							...options.context,
							onOutput(chunk) {
								options.context.onOutput(chunk);

								if (
									options.request.command !== command ||
									chunk.stream !== 'stdout'
								) {
									return;
								}

								output += new TextDecoder().decode(chunk.data);

								if (didKill || !output.includes('owned-ready')) {
									return;
								}

								assert.isDefined(helper);
								finiteDeadline = performance.now() + workloadLifetimeMs + 500;
								didKill = helper.kill('SIGKILL');
							}
						}
					});
				}
			}
		);

		await expect(
			backend.exec(
				{ kind: 'shell', dialect: 'sh', command },
				{
					...context,
					onOutput() {
						return;
					}
				}
			)
		).rejects.toMatchObject({
			name: 'SandboxTransportError',
			completion: 'unknown'
		});

		assert.isDefined(crashed?.targetPid);
		assert.isDefined(crashed);
		assert.isDefined(backend.workspace.home);

		const root = path.dirname(backend.workspace.home);
		const saved: unknown = JSON.parse(
			await readFile(path.join(root, `${crashed.id}.json`), 'utf8')
		);
		const placeholders = new Set(
			defaultProtectedWorkspacePaths.map((entry) => {
				const [topLevel = entry] = entry.split('/', 1);

				return path.join(workspace, topLevel);
			})
		);

		expect({ didKill, saved }).toStrictEqual({
			didKill: true,
			saved: {
				...crashed,
				...(process.platform === 'linux' && {
					placeholders: [...placeholders].toSorted(compareText)
				})
			}
		});
		await expect(
			backend.dispose({
				...context,
				deadline: Date.now() + 5000,
				remainingMs: () => 5000,
				cleanup: { remainingMs: () => 5000, deadline: Date.now() + 5000 }
			})
		).rejects.toMatchObject({ name: 'SandboxCleanupError' });
		await expect(access(root)).resolves.toBeUndefined();
		await writeFile(release, 'go');
		await waitForGroups(jobs);

		let observedEffect: string | undefined;

		try {
			observedEffect = await readFile(effect, 'utf8');
		} catch (error) {
			if (!(
				error instanceof Error &&
				'code' in error &&
				error.code === 'ENOENT'
			)) {
				throw error;
			}
		}

		expect([
			{ members: [], effect: undefined },
			{ members: [], effect: 'continued' }
		]).toContainEqual({
			members: await groupMembers(jobs),
			effect: observedEffect
		});
	} catch (error) {
		failures.push(error);
	}

	try {
		await writeFile(release, 'go');

		for (const helper of helpers) {
			if (helper.exitCode !== null || helper.signalCode !== null) {
				continue;
			}

			const stopped = once(helper, 'exit');

			helper.kill('SIGKILL');
			await stopped;
		}

		await delay(Math.max(0, finiteDeadline - performance.now()));
		await waitForGroups(jobs);

		// Leave the records for inspection when an identity is missing.
		expect(
			jobs
				.values()
				.filter((job) => job.targetPid === undefined)
				.toArray()
		).toStrictEqual([]);

		for (const allocation of allocations) {
			await rm(allocation, { recursive: true, force: true });
		}

		await rm(workspace, { recursive: true, force: true });
	} catch (error) {
		failures.push(error);
	}

	if (failures.length > 0) {
		throw new AggregateError(failures, 'The native crash fixture failed.', {
			cause: failures[0]
		});
	}
}, 30_000);
