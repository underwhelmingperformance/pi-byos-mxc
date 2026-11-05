import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	unlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SandboxOpenContext } from 'pi-bring-your-own-sandbox/api';
import {
	SandboxTimeoutError,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { MxcBackend } from './backend.js';
import { validateConfig } from './config.js';
import { EFFECTIVE_POLICY } from './policy.js';

it.each([
	{ completion: 'confirmed', releaseFails: false },
	{ completion: 'not-started', releaseFails: false },
	{ completion: 'unknown', releaseFails: false },
	{ completion: 'confirmed', releaseFails: true }
] as const)(
	'preserves recovery for $completion completion with removal failure: $releaseFails',
	async ({ completion, releaseFails }) => {
		const temporary = await mkdtemp(
			path.join(tmpdir(), 'pi-byos-mxc-backend-')
		);
		const workspace = await realpath(temporary);
		const allocations = new Set<string>();
		let expectedRecord: { readonly id: string } | undefined;
		const context: SandboxOpenContext = {
			operationId: 'backend-test',
			signal: new AbortController().signal,
			deadline: Date.now() + 10_000,
			cleanup: { deadline: undefined },
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
		const failure =
			completion === 'unknown'
				? new SandboxTransportError({ operation: 'exec', providerId: 'mxc' })
				: new SandboxTimeoutError({
						operation: 'exec',
						completion,
						providerId: 'mxc'
					});

		try {
			const backend = await MxcBackend.open(
				{
					generationId: 'test',
					sessionId: 'test',
					hostWorkspace: workspace,
					policy: EFFECTIVE_POLICY,
					configuration: validateConfig({})
				},
				context,
				{
					prepareRuntime: () =>
						Promise.resolve({
							workspace,
							entry: '/unused-supervisor',
							shells: new Map([['sh', '/bin/sh']]),
							readonlyPaths: [],
							backend: 'seatbelt'
						}),
					createJob: (options) => ({
						limitCleanup() {
							return;
						},
						async run() {
							if (options.request.command === ':') {
								return { kind: 'exited', exit: { kind: 'code', code: 0 } };
							}

							expectedRecord = { id: options.request.id };

							if (releaseFails) {
								const root = allocations.values().next().value;

								if (root === undefined) {
									throw new Error('The fixture did not observe an allocation.');
								}

								const record = path.join(root, `${options.request.id}.json`);

								await unlink(record);
								await mkdir(record);
							}

							throw failure;
						}
					})
				}
			);
			const allocation = path.dirname(backend.workspace.home ?? '');

			const execution = backend.exec(
				{ kind: 'shell', dialect: 'sh', command: 'native-timeout' },
				{
					...context,
					onOutput() {
						return;
					}
				}
			);

			if (releaseFails) {
				const cause: unknown = expect.any(Error);

				await expect(execution).rejects.toMatchObject({
					name: 'AggregateError',
					errors: [failure, cause],
					cause
				});
			} else {
				await expect(execution).rejects.toBe(failure);
			}

			if (expectedRecord === undefined) {
				throw new Error('The fixture did not invoke the target job.');
			}

			const entries = await readdir(allocation);
			const files = entries.filter((file) => file.endsWith('.json'));
			const records = await Promise.all(
				files.map(async (file) => {
					const metadata = await stat(path.join(allocation, file));

					if (metadata.isDirectory()) {
						return { directory: file };
					}

					const record: unknown = JSON.parse(
						await readFile(path.join(allocation, file), 'utf8')
					);

					return record;
				})
			);

			expect(records).toStrictEqual(
				releaseFails
					? [{ directory: `${expectedRecord.id}.json` }]
					: completion === 'unknown'
						? [expectedRecord]
						: []
			);

			if (completion === 'unknown' || releaseFails) {
				await expect(backend.dispose(context)).rejects.toMatchObject({
					name: 'SandboxCleanupError'
				});
				await expect(access(allocation)).resolves.toBeUndefined();

				return;
			}

			await backend.dispose(context);
			await expect(access(allocation)).rejects.toMatchObject({
				code: 'ENOENT'
			});
		} finally {
			for (const allocation of allocations) {
				await rm(allocation, { recursive: true, force: true });
			}

			await rm(workspace, { recursive: true, force: true });
		}
	}
);

it('shortens an existing cancellation budget when disposal starts', async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), 'pi-byos-mxc-disposal-'));
	const allocations = new Set<string>();
	const limits: { readonly deadline: number; readonly aborted: boolean }[] = [];
	const pending = Promise.withResolvers<never>();
	const started = Promise.withResolvers<undefined>();
	const controller = new AbortController();
	const failure = new SandboxTransportError({
		operation: 'exec',
		providerId: 'mxc'
	});
	const context: SandboxOpenContext = {
		operationId: 'disposal',
		signal: new AbortController().signal,
		deadline: Date.now() + 10_000,
		cleanup: { deadline: undefined },
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
	let rejected: Promise<void> | undefined;
	let disposed: Promise<void> | undefined;

	try {
		const backend = await MxcBackend.open(
			{
				generationId: 'test',
				sessionId: 'test',
				hostWorkspace: workspace,
				policy: EFFECTIVE_POLICY,
				configuration: validateConfig({})
			},
			context,
			{
				prepareRuntime: () =>
					Promise.resolve({
						workspace,
						entry: '/unused-supervisor',
						shells: new Map([['sh', '/bin/sh']]),
						readonlyPaths: [],
						backend: 'seatbelt'
					}),
				createJob: (options) => ({
					limitCleanup(deadline: number) {
						limits.push({ deadline, aborted: options.context.signal.aborted });
						pending.reject(failure);
					},
					run() {
						if (options.request.command === ':') {
							return Promise.resolve({
								kind: 'exited',
								exit: { kind: 'code', code: 0 }
							});
						}

						started.resolve(undefined);

						return pending.promise;
					}
				})
			}
		);
		const cleanup: { deadline: number | undefined } = { deadline: undefined };
		const running = backend.exec(
			{ kind: 'shell', dialect: 'sh', command: 'pending' },
			{
				...context,
				signal: controller.signal,
				cleanup: {
					get deadline() {
						return cleanup.deadline;
					}
				},
				onOutput() {
					return;
				}
			}
		);

		rejected = expect(running).rejects.toMatchObject({
			name: 'SandboxTransportError',
			completion: 'unknown'
		});
		await started.promise;
		cleanup.deadline = Date.now() + 10_000;
		controller.abort();

		const originalDeadline = cleanup.deadline;
		const deadline = Date.now() + 100;

		disposed = expect(
			backend.dispose({ ...context, deadline, cleanup: { deadline } })
		).rejects.toMatchObject({ name: 'SandboxCleanupError' });
		expect({ limits, cleanupDeadline: cleanup.deadline }).toStrictEqual({
			limits: [{ deadline, aborted: true }],
			cleanupDeadline: originalDeadline
		});
	} finally {
		pending.reject(failure);
		await Promise.all([rejected, disposed]);

		for (const allocation of allocations) {
			await rm(allocation, { recursive: true, force: true });
		}

		await rm(workspace, { recursive: true, force: true });
	}
});

it('shares disposal with calls reentered from cancellation listeners', async () => {
	const workspace = await mkdtemp(
		path.join(tmpdir(), 'pi-byos-mxc-reentrant-')
	);
	const allocations = new Set<string>();
	const disposals: Promise<void>[] = [];
	const pending = Promise.withResolvers<{
		readonly kind: 'cancelled';
		readonly termination: 'confirmed';
	}>();
	const started = Promise.withResolvers<undefined>();
	let reentered: Promise<void> | undefined;
	const deadline = Date.now() + 5000;
	const context: SandboxOpenContext = {
		operationId: 'reentrant',
		deadline,
		signal: new AbortController().signal,
		cleanup: { deadline },
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
	let running: Promise<unknown> | undefined;

	try {
		const backend = await MxcBackend.open(
			{
				generationId: 'test',
				sessionId: 'test',
				hostWorkspace: workspace,
				policy: EFFECTIVE_POLICY,
				configuration: validateConfig({})
			},
			context,
			{
				prepareRuntime: () =>
					Promise.resolve({
						workspace,
						entry: '/unused-supervisor',
						shells: new Map([['sh', '/bin/sh']]),
						readonlyPaths: [],
						backend: 'seatbelt'
					}),
				createJob: (options) => ({
					limitCleanup() {
						return;
					},
					run() {
						if (options.request.command === ':') {
							return Promise.resolve({
								kind: 'exited',
								exit: { kind: 'code', code: 0 }
							});
						}

						options.context.signal.addEventListener(
							'abort',
							() => {
								reentered = backend.dispose(context);
								disposals.push(reentered);
								pending.resolve({
									kind: 'cancelled',
									termination: 'confirmed'
								});
							},
							{ once: true }
						);
						started.resolve(undefined);

						return pending.promise;
					}
				})
			}
		);

		running = backend.exec(
			{ kind: 'shell', dialect: 'sh', command: 'pending' },
			{
				...context,
				onOutput() {
					return;
				}
			}
		);
		await started.promise;

		const first = backend.dispose(context);

		disposals.push(first);
		expect(reentered).toBe(first);
		await Promise.all(disposals);
	} finally {
		pending.resolve({ kind: 'cancelled', termination: 'confirmed' });
		await Promise.all([...disposals, running]);

		for (const allocation of allocations) {
			await rm(allocation, { recursive: true, force: true });
		}

		await rm(workspace, { recursive: true, force: true });
	}
});
