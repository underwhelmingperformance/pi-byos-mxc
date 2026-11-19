import type { NestedDirectoryJSON } from 'memfs';
import type {
	BackendProcessContext,
	BackendProcessOutcome,
	SandboxDiagnostic,
	SandboxOpenContext,
	SandboxPolicy
} from 'pi-bring-your-own-sandbox/api';
import {
	SandboxCleanupError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxStartupError,
	SandboxTimeoutError,
	SandboxTransportError,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { MxcBackend } from './backend.js';
import { validateConfig } from './config.js';
import { OverlappingPathsError, UnsupportedGrantError } from './errors.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { memoryHost } from './fixtures/host.js';
import { EFFECTIVE_POLICY } from './policy.js';
import { SYSTEM_ROOTS } from './scope.js';
import type { JobOptions } from './supervisor/client.js';
import { parentMessage } from './supervisor/protocol.js';

const root = '/tmp/pi-byos-mxc-00000000-0000-4000-8000-000000000001';
const scratch = `${root}/scratch`;
const firstJob = '00000000-0000-4000-8000-000000000003';
const exited = { kind: 'exited', exit: { kind: 'code', code: 0 } } as const;

function operationContext(
	overrides: Partial<BackendProcessContext & SandboxOpenContext> = {}
): BackendProcessContext & SandboxOpenContext {
	return {
		operationId: 'operation',
		signal: new AbortController().signal,
		deadline: 10_000,
		remainingMs: () => 10_000,
		cleanup: cleanupControl().cleanup,
		reportRecovery() {
			return;
		},
		confirmCleanup() {
			return;
		},
		reportDiagnostic() {
			return;
		},
		onOutput() {
			return;
		},
		...overrides
	};
}

interface FixtureJob {
	run(options: JobOptions): Promise<BackendProcessOutcome>;
	limitCleanup?(remainingMs: number, options: JobOptions): void;
}

interface FixtureHost {
	readonly policy?: SandboxPolicy;
	readonly files?: NestedDirectoryJSON;
	readonly backend?: 'seatbelt' | 'bubblewrap';
	readonly sockets?: readonly string[];
	readonly grants?: readonly string[];
}

async function openBackend(
	job: Partial<FixtureJob> = {},
	{
		policy = EFFECTIVE_POLICY,
		files = {},
		backend: native = 'seatbelt',
		sockets = [],
		grants = []
	}: FixtureHost = {}
) {
	const run = job.run ?? (() => Promise.resolve(exited));
	const { host, memory } = memoryHost(
		{ '/workspace/nested': {}, ...files },
		{
			environment: { platform: native === 'seatbelt' ? 'darwin' : 'linux' },
			sockets
		}
	);
	const context = operationContext();
	const backend = await MxcBackend.open(
		{
			generationId: 'test',
			sessionId: 'test',
			hostWorkspace: '/workspace',
			policy,
			configuration: validateConfig({})
		},
		context,
		{
			host,
			prepareRuntime: () =>
				Promise.resolve({
					workspace: '/workspace',
					entry: '/unused-supervisor',
					shells: new Map([['sh', '/bin/sh']]),
					readonlyPaths: ['/bin/sh', ...grants],
					configuredPaths: ['/bin/sh', ...grants],
					backend: native
				}),
			createJob: (options) => ({
				limitCleanup(remainingMs) {
					job.limitCleanup?.(remainingMs, options);
				},
				run: () =>
					options.request.command === ':'
						? Promise.resolve(exited)
						: run(options)
			})
		}
	);

	return { backend, context, memory };
}

function records(memory: ReturnType<typeof memoryHost>['memory']) {
	return memory
		.readdirSync(root)
		.map(String)
		.filter((name) => name.endsWith('.json'))
		.map((name) => {
			const filename = `${root}/${name}`;

			return memory.statSync(filename).isDirectory()
				? { directory: name }
				: (JSON.parse(
						String(memory.readFileSync(filename, 'utf8'))
					) as unknown);
		});
}

it.each([
	{
		completion: 'confirmed',
		failure: new SandboxTimeoutError({
			operation: 'exec',
			completion: 'confirmed',
			providerId: 'mxc'
		}),
		retained: []
	},
	{
		completion: 'not-started',
		failure: new SandboxTimeoutError({
			operation: 'exec',
			completion: 'not-started',
			providerId: 'mxc'
		}),
		retained: []
	},
	{
		completion: 'before-start',
		failure: new SandboxOperationError({
			operation: 'exec',
			providerId: 'mxc'
		}),
		retained: []
	},
	{
		completion: 'unknown',
		failure: new SandboxTransportError({
			operation: 'exec',
			providerId: 'mxc'
		}),
		retained: [{ id: firstJob }]
	}
])(
	'keeps recovery records only for $completion completion that may leave a target',
	async ({ failure, retained }) => {
		const { backend, context, memory } = await openBackend({
			run: () => Promise.reject(failure)
		});

		await expect(
			backend.exec({ kind: 'shell', dialect: 'sh', command: 'job' }, context)
		).rejects.toBe(failure);
		expect(records(memory)).toStrictEqual(retained);

		if (retained.length > 0) {
			await expect(backend.dispose(context)).rejects.toStrictEqual(
				new SandboxCleanupError({
					operation: 'dispose',
					providerId: 'mxc',
					recovery: backend.recovery
				})
			);
			expect(memory.existsSync(root)).toBe(true);

			return;
		}

		await backend.dispose(context);
		expect(memory.existsSync(root)).toBe(false);
	}
);

it('reports a confirmed completion whose recovery record cannot be removed', async () => {
	const failure = new SandboxTimeoutError({
		operation: 'exec',
		completion: 'confirmed',
		providerId: 'mxc'
	});
	const fixture = await openBackend({
		run(options) {
			const record = `${root}/${options.request.id}.json`;

			fixture.memory.unlinkSync(record);
			fixture.memory.mkdirSync(record);

			return Promise.reject(failure);
		}
	});
	const { backend, context, memory } = fixture;
	const execution = backend.exec(
		{ kind: 'shell', dialect: 'sh', command: 'job' },
		context
	);
	const cause: unknown = expect.objectContaining({ code: 'EPERM' });

	await expect(execution).rejects.toMatchObject({
		name: 'AggregateError',
		message:
			'MXC process completion was established, but its recovery state could not be cleared.',
		errors: [failure, cause],
		cause
	});
	expect(records(memory)).toStrictEqual([{ directory: `${firstJob}.json` }]);
	await expect(backend.dispose(context)).rejects.toStrictEqual(
		new SandboxCleanupError({
			operation: 'dispose',
			providerId: 'mxc',
			recovery: backend.recovery
		})
	);
});

it('limits an existing cancellation allowance when disposal starts', async () => {
	const failure = new SandboxTransportError({
		operation: 'exec',
		providerId: 'mxc'
	});
	const pending = Promise.withResolvers<never>();
	const started = Promise.withResolvers<JobOptions>();
	const limits: unknown[] = [];
	const { backend, context } = await openBackend({
		run(options) {
			started.resolve(options);

			return pending.promise;
		},
		limitCleanup(remainingMs, options) {
			limits.push({
				remainingMs,
				aborted: options.context.signal.aborted,
				jobAllowance: options.context.cleanup.remainingMs()
			});
			pending.reject(failure);
		}
	});
	const controller = new AbortController();
	const cancellation = cleanupControl();
	const running = backend.exec(
		{ kind: 'shell', dialect: 'sh', command: 'pending' },
		{ ...context, signal: controller.signal, cleanup: cancellation.cleanup }
	);
	const rejected = expect(running).rejects.toBe(failure);

	await started.promise;
	cancellation.publish(10_000);
	controller.abort();

	const disposed = expect(
		backend.dispose({
			...context,
			cleanup: { remainingMs: () => 100, deadline: undefined }
		})
	).rejects.toStrictEqual(
		new SandboxCleanupError({
			operation: 'dispose',
			providerId: 'mxc',
			recovery: backend.recovery
		})
	);

	expect(limits).toStrictEqual([
		{ remainingMs: 100, aborted: true, jobAllowance: 10_000 }
	]);
	await Promise.all([rejected, disposed]);
});

it('gives a job stopped by disposal the disposal cleanup allowance', async () => {
	const allowances: (number | undefined)[] = [];
	const started = Promise.withResolvers<undefined>();
	const { backend, context } = await openBackend({
		run: (options) =>
			new Promise((resolve) => {
				options.context.signal.addEventListener(
					'abort',
					() => {
						allowances.push(options.context.cleanup.remainingMs());
						resolve({ kind: 'cancelled', termination: 'confirmed' });
					},
					{ once: true }
				);
				started.resolve(undefined);
			})
	});
	const running = backend.exec(
		{ kind: 'shell', dialect: 'sh', command: 'pending' },
		context
	);

	await started.promise;
	await backend.dispose({
		...context,
		cleanup: { remainingMs: () => 250, deadline: undefined }
	});

	expect({ result: await running, allowances }).toStrictEqual({
		result: { kind: 'cancelled', termination: 'confirmed' },
		allowances: [250]
	});
});

it('shares disposal with calls reentered from cancellation listeners', async () => {
	const disposals: Promise<void>[] = [];
	const started = Promise.withResolvers<undefined>();
	const fixture = await openBackend({
		run: (options) =>
			new Promise((resolve) => {
				options.context.signal.addEventListener(
					'abort',
					() => {
						disposals.push(fixture.backend.dispose(fixture.context));
						resolve({ kind: 'cancelled', termination: 'confirmed' });
					},
					{ once: true }
				);
				started.resolve(undefined);
			})
	});
	const { backend, context } = fixture;
	const running = backend.exec(
		{ kind: 'shell', dialect: 'sh', command: 'pending' },
		context
	);

	await started.promise;

	const first = backend.dispose(context);

	expect(disposals).toStrictEqual([first]);
	await Promise.all([first, running]);
});

it('rejects a missing working directory before starting a job', async () => {
	const jobs: string[] = [];
	const { backend, context } = await openBackend({
		run(options) {
			jobs.push(options.request.cwd);

			return Promise.resolve(exited);
		}
	});

	await expect(
		backend.exec(
			{ kind: 'shell', dialect: 'sh', command: 'true', cwd: 'missing' },
			context
		)
	).rejects.toStrictEqual(
		new SandboxPathNotFoundError({ operation: 'exec', providerId: 'mxc' })
	);
	expect({
		result: await backend.exec(
			{ kind: 'shell', dialect: 'sh', command: 'true', cwd: 'nested' },
			context
		),
		jobs
	}).toStrictEqual({ result: exited, jobs: ['/workspace/nested'] });
});

it.each([
	{
		workspaceAccess: 'read-write',
		grants: {
			readwritePaths: ['/workspace', scratch],
			readonlyPaths: ['/bin/sh']
		}
	},
	{
		workspaceAccess: 'read-only',
		grants: {
			readwritePaths: [scratch],
			readonlyPaths: ['/workspace', '/bin/sh']
		}
	}
] as const)(
	'grants the workspace for $workspaceAccess access',
	async ({ workspaceAccess, grants }) => {
		const policy = { ...EFFECTIVE_POLICY, workspaceAccess };
		const requests: JobOptions['request'][] = [];
		const { backend, context } = await openBackend(
			{
				run(options) {
					requests.push(options.request);

					return Promise.resolve(exited);
				}
			},
			{ policy }
		);

		await backend.exec(
			{ kind: 'shell', dialect: 'sh', command: 'true' },
			context
		);

		expect({
			id: backend.id,
			policy: backend.policy,
			grants: requests.map(({ readwritePaths, readonlyPaths }) => ({
				readwritePaths,
				readonlyPaths
			})),
			isValid: requests.map((request) => parentMessage.Check(request))
		}).toStrictEqual({
			id: 'mxc:test:00000000-0000-4000-8000-000000000001',
			policy,
			grants: [grants],
			isValid: [true]
		});
	}
);

it('reports the configuration problem when opening fails', async () => {
	const diagnostics: SandboxDiagnostic[] = [];
	const failure = new OverlappingPathsError('/a', '/a/b');

	await expect(
		MxcBackend.open(
			{
				generationId: 'test',
				sessionId: 'test',
				hostWorkspace: '/unused',
				policy: EFFECTIVE_POLICY,
				configuration: validateConfig({})
			},
			operationContext({
				reportDiagnostic(diagnostic) {
					diagnostics.push(diagnostic);
				}
			}),
			{
				host: memoryHost().host,
				prepareRuntime: () => Promise.reject(failure),
				createJob: () => expect.unreachable()
			}
		)
	).rejects.toStrictEqual(
		new SandboxStartupError(
			{ operation: 'open', providerId: 'mxc' },
			{ cause: failure }
		)
	);
	expect(diagnostics).toStrictEqual([
		{ level: 'warning', message: failure.message }
	]);
});

it('removes private directories when settled disposal finishes after its deadline', async () => {
	const { backend, context, memory } = await openBackend();
	const controller = new AbortController();

	controller.abort();
	await backend.dispose({ ...context, signal: controller.signal });

	expect(memory.existsSync(root)).toBe(false);
});

it('grants protected workspace entries read-only and records the protection', async () => {
	const requests: JobOptions['request'][] = [];
	const policy: SandboxPolicy = {
		...EFFECTIVE_POLICY,
		workspaceProtection: [
			{ kind: 'path', path: '.envrc' },
			{ kind: 'path', path: '.pi' }
		]
	};
	const { backend, context } = await openBackend(
		{
			run(options) {
				requests.push(options.request);

				return Promise.resolve(exited);
			}
		},
		{ policy, files: { '/workspace/.pi/settings.json': '{}' } }
	);

	await backend.exec(
		{ kind: 'shell', dialect: 'sh', command: 'true' },
		context
	);

	expect({
		policy: backend.policy,
		readonlyPaths: requests.map((request) => request.readonlyPaths)
	}).toStrictEqual({
		policy,
		readonlyPaths: [['/workspace/.envrc', '/workspace/.pi', '/bin/sh']]
	});
});

it('covers an absent protected entry with a placeholder while a Bubblewrap command runs', async () => {
	const observed: unknown[] = [];
	const fixture = await openBackend(
		{
			run(options) {
				observed.push({
					readwritePaths: options.request.readwritePaths,
					readonlyPaths: options.request.readonlyPaths,
					placeholder: fixture.memory.statSync('/workspace/hooks/pre').size
				});

				return Promise.resolve(exited);
			}
		},
		{
			backend: 'bubblewrap',
			files: { '/workspace/hooks': {} },
			policy: {
				...EFFECTIVE_POLICY,
				workspaceProtection: [{ kind: 'path', path: 'hooks/pre' }]
			}
		}
	);
	const { backend, context, memory } = fixture;

	await backend.exec(
		{ kind: 'shell', dialect: 'sh', command: 'true' },
		context
	);

	expect({
		observed,
		after: memory.existsSync('/workspace/hooks/pre')
	}).toStrictEqual({
		observed: [
			{
				readwritePaths: ['/workspace', scratch, '/workspace/hooks'],
				readonlyPaths: ['/workspace/hooks/pre', '/bin/sh'],
				placeholder: 0
			}
		],
		after: false
	});
});

it('keeps a placeholder and records it when the command outcome is unknown', async () => {
	const failure = new SandboxTransportError({
		operation: 'exec',
		providerId: 'mxc'
	});
	const { backend, context, memory } = await openBackend(
		{ run: () => Promise.reject(failure) },
		{
			backend: 'bubblewrap',
			policy: {
				...EFFECTIVE_POLICY,
				workspaceProtection: [{ kind: 'path', path: '.envrc' }]
			}
		}
	);

	await expect(
		backend.exec({ kind: 'shell', dialect: 'sh', command: 'job' }, context)
	).rejects.toBe(failure);
	expect({
		placeholder: memory.existsSync('/workspace/.envrc'),
		records: records(memory)
	}).toStrictEqual({
		placeholder: true,
		records: [{ id: firstJob, placeholders: ['/workspace/.envrc'] }]
	});
});

it.each([
	{ backend: 'seatbelt', deniedPaths: [] },
	{
		backend: 'bubblewrap',
		deniedPaths: ['/run/systemd/resolve/io.systemd.Resolve']
	}
] as const)(
	'denies host resolver sockets with $backend',
	async ({ backend: native, deniedPaths }) => {
		const requests: JobOptions['request'][] = [];
		const { backend, context } = await openBackend(
			{
				run(options) {
					requests.push(options.request);

					return Promise.resolve(exited);
				}
			},
			{
				backend: native,
				files: { '/run/systemd/resolve/io.systemd.Resolve': '' },
				sockets: ['/run/systemd/resolve/io.systemd.Resolve']
			}
		);

		await backend.exec(
			{ kind: 'shell', dialect: 'sh', command: 'true' },
			context
		);

		expect(requests.map((request) => request.deniedPaths)).toStrictEqual([
			deniedPaths
		]);
	}
);

it('accepts system grants for system-read-only', async () => {
	const { backend } = await openBackend(
		{},
		{
			grants: ['/opt/homebrew/bin'],
			policy: { ...EFFECTIVE_POLICY, filesystemScope: 'system-read-only' }
		}
	);

	expect(backend.policy).toStrictEqual({
		...EFFECTIVE_POLICY,
		filesystemScope: 'system-read-only'
	});
});

it('rejects a configured grant outside system directories for system-read-only', async () => {
	const cause = new UnsupportedGrantError(
		'/home/user/.local/bin',
		SYSTEM_ROOTS.darwin ?? []
	);

	await expect(
		openBackend(
			{},
			{
				grants: ['/home/user/.local/bin'],
				policy: { ...EFFECTIVE_POLICY, filesystemScope: 'system-read-only' }
			}
		)
	).rejects.toStrictEqual(
		new UnsupportedSandboxPolicyError(
			{ operation: 'open', providerId: 'mxc' },
			{ cause }
		)
	);
});
