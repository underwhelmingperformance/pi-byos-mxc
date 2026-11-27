import type { NestedDirectoryJSON } from 'memfs';
import type { SandboxDiagnostic } from 'pi-bring-your-own-sandbox/host';
import type {
	BackendProcessContext,
	BackendProcessOutcome,
	RecoveryDescriptor,
	SandboxOpenContext,
	SandboxPolicy
} from 'pi-bring-your-own-sandbox/provider';
import {
	SandboxCleanupError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxStartupError,
	SandboxTransportError,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/provider';
import { assert, expect, it } from 'vitest';

import { MxcBackend } from './backend.js';
import { validateConfig } from './config.js';
import { OverlappingPathsError, ShellStartupError } from './errors.js';
import { cleanupControl } from './fixtures/cleanup.js';
import { memoryHost } from './fixtures/host.js';
import { defaultPolicy, fixtureProfile } from './fixtures/profiles.js';
import { transportCommand } from './shell.js';
import type { JobOptions } from './supervisor/client.js';
import { MAX_START_BYTES, parentMessage } from './supervisor/protocol.js';

const root = '/tmp/pi-byos-mxc-00000000-0000-4000-8000-000000000001';
const scratch = `${root}/scratch`;
const firstJob = '00000000-0000-4000-8000-000000000004';
const presetPaths = [
	'/workspace/.aws',
	'/workspace/.bash_login',
	'/workspace/.bash_profile',
	'/workspace/.bashrc',
	'/workspace/.config',
	'/workspace/.devcontainer',
	'/workspace/.direnv',
	'/workspace/.envrc',
	'/workspace/.git',
	'/workspace/.idea',
	'/workspace/.mcp.json',
	'/workspace/.pi',
	'/workspace/.profile',
	'/workspace/.vscode',
	'/workspace/.zlogin',
	'/workspace/.zlogout',
	'/workspace/.zprofile',
	'/workspace/.zshenv',
	'/workspace/.zshrc'
];
const exited = { kind: 'exited', exit: { kind: 'code', code: 0 } } as const;

class Timeout extends Error {
	override readonly name = 'SandboxTimeoutError';
	readonly operation = 'exec';
	readonly reason = 'deadline';
	readonly providerId = 'mxc';

	constructor(readonly completion: 'confirmed' | 'not-started') {
		super('Fixture timeout.');
	}
}

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
	readonly protectPaths?: readonly string[];
	readonly sh?: string;
	readonly environment?: Readonly<Record<string, string>>;
	readonly abortBash?: boolean;
	readonly reportRecovery?: SandboxOpenContext['reportRecovery'];
	readonly reportDiagnostic?: SandboxOpenContext['reportDiagnostic'];
}

async function openBackend(
	job: Partial<FixtureJob> = {},
	{
		policy = defaultPolicy,
		files = {},
		backend: native = 'seatbelt',
		sockets = [],
		protectPaths = [],
		sh = '/bin/sh',
		environment = {},
		abortBash = false,
		reportRecovery,
		reportDiagnostic
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
	const context = operationContext({
		...(reportRecovery && { reportRecovery }),
		...(reportDiagnostic && { reportDiagnostic })
	});
	const backend = await MxcBackend.open(
		{
			generationId: 'test',
			sessionId: 'test',
			hostWorkspace: '/workspace',
			profile: fixtureProfile(policy, host.environment.platform),
			configuration: validateConfig({
				protectPaths: [...protectPaths],
				environment
			})
		},
		context,
		{
			host,
			prepareRuntime: () =>
				Promise.resolve({
					workspace: '/workspace',
					entry: '/unused-supervisor',
					shells: new Map([
						['sh', sh],
						['bash', '/bin/bash']
					]),
					readonlyPaths: ['/bin/sh'],
					protectedPaths: [],
					backend: native
				}),
			createJob: (options) => ({
				limitCleanup(remainingMs) {
					job.limitCleanup?.(remainingMs, options);
				},
				run: () =>
					options.request.command === ':' ||
					options.request.command === '[[ 1 == 1 ]]'
						? Promise.resolve(
								abortBash && options.request.command !== ':'
									? { kind: 'exited', exit: { kind: 'code', code: 1 } }
									: exited
							)
						: run(options)
			})
		}
	);

	return { backend, context, memory };
}

it.each(['seatbelt', 'bubblewrap'] as const)(
	'refuses a nested socket before allocating with %s',
	async (backend) => {
		const socket = '/workspace/nested/socket\u{1B}';
		const recovery: RecoveryDescriptor[] = [];
		const diagnostics: SandboxDiagnostic[] = [];

		await expect(
			openBackend(
				{},
				{
					backend,
					files: { [socket]: '' },
					sockets: [socket],
					reportRecovery(descriptor) {
						recovery.push(descriptor);
					},
					reportDiagnostic(diagnostic) {
						diagnostics.push(diagnostic);
					}
				}
			)
		).rejects.toBeInstanceOf(UnsupportedSandboxPolicyError);
		expect(recovery).toStrictEqual([{ kind: 'none' }]);
		expect(diagnostics).toStrictEqual([
			{
				level: 'warning',
				message: String.raw`MXC cannot open the live checkout with the special file nested/socket\x1b. Remove sockets, FIFOs and device files before opening it.`
			}
		]);
	}
);

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

it.each(['denied', 'read-only'] as const)(
	'publishes the host user data location for %s access',
	async (hostUserData) => {
		const { backend, context } = await openBackend(
			{},
			{
				policy: { ...defaultPolicy, hostUserData },
				files: { '/home/user': {} }
			}
		);

		try {
			expect(backend.workspace).toStrictEqual({
				root: '/workspace',
				pathFlavor: 'posix',
				relationship: 'shared',
				home: scratch,
				...(hostUserData === 'read-only' && { hostUserDataRoot: '/home/user' }),
				defaultShell: 'sh',
				description:
					'Shared host workspace; changes persist. Private home/scratch lasts until generation disposal.'
			});
		} finally {
			await backend.dispose(context);
		}
	}
);

it.each([
	{ native: 'seatbelt', network: false },
	{ native: 'seatbelt', network: true },
	{ native: 'bubblewrap', network: false }
] as const)(
	'launches SDK search with ordinary command authority on $native with network $network',
	async ({ native, network }) => {
		const requests: JobOptions[] = [];
		const clearNodeEnvironment = { NODE_OPTIONS: '', NODE_PATH: '' };
		const { backend, context } = await openBackend(
			{
				run(options) {
					requests.push(options);
					options.context.onOutput({
						stream: 'stdout',
						data: Buffer.from('{"paths":["notes.txt"],"truncated":false}')
					});

					return Promise.resolve(exited);
				}
			},
			{
				backend: native,
				policy: { ...defaultPolicy, network },
				sh: '/custom/sh',
				environment: { MXC_TEST: 'configured', NODE_OPTIONS: '--invalid' }
			}
		);

		try {
			await backend.exec(
				{
					kind: 'shell',
					dialect: 'sh',
					command: 'true',
					env: clearNodeEnvironment
				},
				context
			);

			const result = await backend.search?.find?.(
				{ pattern: '*.txt' },
				context
			);
			const [ordinary, search] = requests;

			expect(result).toStrictEqual({ paths: ['notes.txt'], truncated: false });
			assert.isDefined(ordinary);
			assert.isDefined(search);
			expect({ ...search.request, id: ordinary.request.id }).toStrictEqual({
				...ordinary.request,
				command:
					"exec '/runtime/node/bin/node' '--input-type=module' '-' 'find' 'pattern=*.txt' '16777216' '/workspace'"
			});
			expect(search.input?.byteLength).toBeGreaterThan(0);
			expect(Buffer.byteLength(JSON.stringify(search.request))).toBeLessThan(
				MAX_START_BYTES
			);

			const command = transportCommand({
				...search.request,
				gate: search.request.id
			});

			expect(Buffer.byteLength(command) + 1).toBeLessThanOrEqual(128 * 1024);
		} finally {
			await backend.dispose(context);
		}
	}
);

it.each([
	{
		completion: 'confirmed',
		failure: new Timeout('confirmed'),
		retained: []
	},
	{
		completion: 'not-started',
		failure: new Timeout('not-started'),
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
	const failure = new Timeout('confirmed');
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
		hostWorkspaceWrites: true,
		grants: {
			readwritePaths: [scratch, '/workspace'],
			readonlyPaths: ['/bin/sh', ...presetPaths]
		}
	},
	{
		hostWorkspaceWrites: false,
		grants: {
			readwritePaths: [scratch],
			readonlyPaths: ['/bin/sh', '/workspace']
		}
	}
] as const)(
	'grants the workspace for $hostWorkspaceWrites access',
	async ({ hostWorkspaceWrites, grants }) => {
		const policy = { ...defaultPolicy, hostWorkspaceWrites };
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
			policy: backend.profile.policy,
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
				profile: fixtureProfile({}, 'darwin'),
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

	const { backend, context } = await openBackend(
		{
			run(options) {
				requests.push(options.request);

				return Promise.resolve(exited);
			}
		},
		{ files: { '/workspace/.pi/settings.json': '{}' } }
	);

	await backend.exec(
		{ kind: 'shell', dialect: 'sh', command: 'true' },
		context
	);

	expect({
		policy: backend.profile.policy,
		readonlyPaths: requests.map((request) => request.readonlyPaths)
	}).toStrictEqual({
		policy: defaultPolicy,
		readonlyPaths: [['/bin/sh', ...presetPaths]]
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
			protectPaths: ['hooks/pre']
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
				readwritePaths: [scratch, '/workspace', '/workspace/hooks'],
				readonlyPaths: ['/bin/sh', ...presetPaths, '/workspace/hooks/pre'],
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
			protectPaths: ['.envrc']
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
		records: [{ id: firstJob, placeholders: presetPaths }]
	});
});

it.each([
	{ backend: 'seatbelt', network: false, deniedPaths: [] },
	{
		backend: 'bubblewrap',
		network: false,
		deniedPaths: ['/run', '/var/run']
	},
	{
		backend: 'bubblewrap',
		network: true,
		deniedPaths: ['/run/systemd/resolve/io.systemd.Resolve']
	}
] as const)(
	'masks host resolver paths with $backend and network $network',
	async ({ backend: native, network, deniedPaths }) => {
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
				policy: { ...defaultPolicy, network },
				files: {
					'/run/systemd/resolve/io.systemd.Resolve': '',
					'/var/run': {}
				},
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

it('fails startup if Bash cannot execute inside the sandbox', async () => {
	await expect(openBackend({}, { abortBash: true })).rejects.toStrictEqual(
		new SandboxStartupError(
			{ operation: 'open', providerId: 'mxc' },
			{ cause: new ShellStartupError('bash') }
		)
	);
});
