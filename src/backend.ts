import path from 'node:path';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessRequest,
	RecoveryDescriptor,
	SandboxBackend,
	SandboxCapabilities,
	SandboxCleanupContext,
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxOperationContext,
	SandboxPolicy,
	SandboxWorkspace,
	ShellDialect
} from 'pi-bring-your-own-sandbox/api';
import {
	InvalidSandboxRequestError,
	isSandboxError,
	SandboxCleanupError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError,
	SandboxSessionClosingError,
	SandboxStartupError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/api';

import type { MxcConfig } from './config.js';
import { MxcConfigError, UnenforceablePolicyError } from './errors.js';
import type { Host, HostFileSystem } from './host.js';
import { systemHost } from './host.js';
import { assertDisjointPaths } from './paths.js';
import { resolverSockets } from './platform/system-paths.js';
import { EFFECTIVE_POLICY } from './policy.js';
import { protectedPaths } from './protection.js';
import { RecoveryStore } from './recovery.js';
import type { MxcRuntime } from './runtime.js';
import { prepareRuntime } from './runtime.js';
import { assertSystemGrants, SYSTEM_ROOTS } from './scope.js';
import { SYSTEM_PATH, targetEnvironment } from './shell.js';
import type { JobOptions } from './supervisor/client.js';
import { SupervisorJob } from './supervisor/client.js';
import type { StartMessage } from './supervisor/protocol.js';
import { MAX_START_BYTES } from './supervisor/protocol.js';

type JobRunner = Pick<SupervisorJob, 'run' | 'limitCleanup'>;

interface BackendDependencies {
	readonly host: Host;
	readonly prepareRuntime: typeof prepareRuntime;
	readonly createJob: (options: JobOptions) => JobRunner;
}

const DEFAULT_DEPENDENCIES: BackendDependencies = Object.freeze({
	host: systemHost,
	prepareRuntime,
	createJob: (options: JobOptions) => new SupervisorJob(options)
});

function capabilities(
	shells: ReadonlyMap<ShellDialect, string>
): SandboxCapabilities {
	return Object.freeze({
		operations: Object.freeze(['exec', 'workspace.protection'] as const),
		processKinds: Object.freeze(['shell'] as const),
		shells: Object.freeze(shells.keys().toArray()),
		exitStatus: 'optional',
		terminationScope: 'process-group'
	});
}

function describePolicy(
	runtime: MxcRuntime & { readonly protectedEntries: readonly string[] },
	policy: SandboxPolicy,
	network: MxcConfig['network'],
	platform: NodeJS.Platform
): string {
	const isSeatbelt = runtime.backend === 'seatbelt';
	const socketScope = [
		'in the writable workspace',
		...(isSeatbelt ? [] : ['in read-only grants']),
		...(isSeatbelt && network === 'open-egress' ? ['anywhere on the host'] : [])
	].join(' and ');
	const filesystem =
		policy.filesystemScope === 'system-read-only'
			? `Read-only host access is limited to system and runtime directories: MXC's baseline plus configured grants inside ${(SYSTEM_ROOTS[platform] ?? []).join(', ')}.${isSeatbelt ? ' File metadata, such as existence and size, remains visible for other host paths.' : ''}`
			: 'Baseline host system reads plus configured read-only grants.';

	return [
		`MXC ${runtime.backend}; ${policy.workspaceAccess === 'read-write' ? 'writable' : 'read-only'} shared workspace and private writable scratch.`,
		filesystem,
		...(runtime.protectedEntries.length > 0
			? [
					`Read-only protected workspace entries: ${runtime.protectedEntries.join(', ')}.`
				]
			: []),
		`${network} external IP mode, with ingress and host-loopback IP denied.`,
		`Commands can connect to host services through UNIX sockets ${socketScope}; those services can make network connections on the command's behalf.`,
		'No general resource quotas.',
		'Termination covers only the direct process and original supervised POSIX group. Descendants in other groups or sessions may keep modifying permitted files after completion, cancellation, timeout or disposal, even when their parent waited.',
		'Detached submission is not supported.'
	].join(' ');
}

async function workingDirectory(
	fs: HostFileSystem,
	filename: string
): Promise<string> {
	const identity = { operation: 'exec', providerId: 'mxc' } as const;

	try {
		const metadata = await fs.stat(filename);

		if (metadata.isDirectory()) {
			return filename;
		}
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			(error.code === 'EACCES' || error.code === 'EPERM')
		) {
			throw new SandboxPermissionDeniedError(identity, { cause: error });
		}

		if (!(
			error instanceof Error &&
			'code' in error &&
			(error.code === 'ENOENT' || error.code === 'ENOTDIR')
		)) {
			throw error;
		}
	}

	throw new SandboxPathNotFoundError(identity);
}

export class MxcBackend implements SandboxBackend {
	static async open(
		request: SandboxOpenRequest<MxcConfig>,
		context: SandboxOpenContext,
		overrides: Partial<BackendDependencies> = {}
	): Promise<SandboxBackend> {
		const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
		let store: RecoveryStore | undefined;

		context.reportRecovery({ kind: 'none' });

		try {
			if (
				request.policy.filesystemScope === 'workspace-only' ||
				request.policy.networkAccess !== 'provider-default'
			) {
				throw new UnsupportedSandboxPolicyError({
					operation: 'open',
					providerId: 'mxc'
				});
			}

			const runtime = await dependencies.prepareRuntime(
				request.hostWorkspace,
				request.configuration,
				context
			);

			if (request.policy.filesystemScope === 'system-read-only') {
				assertSystemGrants(
					dependencies.host.environment.platform,
					runtime.configuredPaths
				);
			}

			const protectedEntries = await protectedPaths(dependencies.host, {
				workspace: runtime.workspace,
				backend: runtime.backend,
				workspaceAccess: request.policy.workspaceAccess,
				resources: request.policy.workspaceProtection ?? []
			});

			store = await RecoveryStore.open(
				runtime.workspace,
				context,
				dependencies.host
			);
			assertDisjointPaths(store.scratch, runtime.readonlyPaths);

			const backend = new MxcBackend(
				request,
				{ ...runtime, protectedEntries },
				store,
				dependencies
			);
			const probeContext: BackendProcessContext = {
				...context,
				onOutput() {
					return;
				}
			};
			const sh = await backend.exec(
				{ kind: 'shell', dialect: 'sh', command: ':' },
				probeContext
			);

			if (
				sh.kind !== 'exited' ||
				sh.exit.kind !== 'code' ||
				sh.exit.code !== 0
			) {
				throw new SandboxStartupError({
					operation: 'open',
					providerId: 'mxc',
					recovery: store.recovery
				});
			}

			if (backend.#shells.has('bash')) {
				const bash = await backend.exec(
					{ kind: 'shell', dialect: 'bash', command: '[[ 1 == 1 ]]' },
					probeContext
				);

				if (
					bash.kind !== 'exited' ||
					bash.exit.kind !== 'code' ||
					bash.exit.code !== 0
				) {
					backend.#shells.delete('bash');
					backend.#capabilities = capabilities(backend.#shells);
					context.reportDiagnostic({
						level: 'warning',
						message:
							'Bash could not execute inside MXC. This backend offers sh only.'
					});
				}
			}

			if (context.signal.aborted) {
				throw new SandboxStartupError({ operation: 'open', providerId: 'mxc' });
			}

			return backend;
		} catch (error) {
			if (store !== undefined) {
				try {
					await store.dispose();
				} catch (cleanupError) {
					throw new SandboxCleanupError(
						{ operation: 'open', providerId: 'mxc', recovery: store.recovery },
						{
							cause: new AggregateError(
								[error, cleanupError],
								'MXC opening and allocation cleanup failed.'
							)
						}
					);
				}
			}

			if (isSandboxError(error, SandboxCleanupError)) {
				throw error;
			}

			if (isSandboxError(error)) {
				context.confirmCleanup();

				throw error;
			}

			if (error instanceof UnenforceablePolicyError) {
				context.reportDiagnostic({
					level: 'warning',
					message: error.message.slice(0, 2048)
				});
				context.confirmCleanup();

				throw new UnsupportedSandboxPolicyError(
					{ operation: 'open', providerId: 'mxc' },
					{ cause: error }
				);
			}

			context.reportDiagnostic({
				level: 'warning',
				message:
					error instanceof MxcConfigError
						? error.message.slice(0, 2048)
						: 'MXC opening failed. Check runtime availability, shell/toolchain grants and that the provider is installed outside the writable workspace.'
			});

			context.confirmCleanup();

			throw new SandboxStartupError(
				{ operation: 'open', providerId: 'mxc' },
				{ cause: error }
			);
		}
	}

	readonly #host: Host;
	readonly #createJob: BackendDependencies['createJob'];
	readonly #runtime: MxcRuntime;
	readonly #configuration: MxcConfig;
	readonly #store: RecoveryStore;
	readonly #grants: Pick<StartMessage, 'readwritePaths' | 'readonlyPaths'>;
	readonly #shells: Map<ShellDialect, string>;
	readonly #lifetime = new AbortController();
	readonly #jobs = new Set<Promise<BackendProcessOutcome>>();
	readonly #runners = new Set<JobRunner>();
	#capabilities: SandboxCapabilities;
	#isClosing = false;
	#disposalCleanup: SandboxCleanupContext | undefined;
	#disposal: Promise<void> | undefined;
	readonly id: string;
	readonly workspace: SandboxWorkspace;
	readonly policy: SandboxPolicy;
	readonly policyDescription: string;
	readonly recovery: RecoveryDescriptor;

	private constructor(
		request: SandboxOpenRequest<MxcConfig>,
		runtime: MxcRuntime & { readonly protectedEntries: readonly string[] },
		store: RecoveryStore,
		dependencies: BackendDependencies
	) {
		this.#host = dependencies.host;
		this.#createJob = dependencies.createJob;
		this.#runtime = runtime;
		this.#configuration = request.configuration;
		this.#store = store;
		this.#shells = new Map(runtime.shells);
		this.#capabilities = capabilities(this.#shells);

		const protection = request.policy.workspaceProtection;

		this.policy = Object.freeze({
			...EFFECTIVE_POLICY,
			workspaceAccess: request.policy.workspaceAccess,
			filesystemScope: request.policy.filesystemScope,
			...(protection !== undefined && { workspaceProtection: protection })
		});
		this.id = `mxc:${request.generationId}:${store.id}`;

		const isWritable = this.policy.workspaceAccess === 'read-write';

		this.workspace = Object.freeze({
			root: runtime.workspace,
			pathFlavor: 'posix',
			relationship: 'shared',
			home: store.scratch,
			defaultShell: 'sh',
			description: isWritable
				? 'Shared host workspace; changes persist. Private home/scratch lasts until generation disposal.'
				: 'Shared host workspace, read-only inside the sandbox; host changes are visible. Private writable home/scratch lasts until generation disposal.'
		});
		this.recovery = store.recovery;
		this.#grants = isWritable
			? {
					readwritePaths: [runtime.workspace, store.scratch],
					readonlyPaths: [...runtime.protectedEntries, ...runtime.readonlyPaths]
				}
			: {
					readwritePaths: [store.scratch],
					readonlyPaths: [runtime.workspace, ...runtime.readonlyPaths]
				};
		this.policyDescription = describePolicy(
			runtime,
			this.policy,
			request.configuration.network,
			dependencies.host.environment.platform
		);
	}

	async #execute(
		request: ProcessRequest & { kind: 'shell' },
		context: BackendProcessContext,
		shell: string
	): Promise<BackendProcessOutcome> {
		const cwd = await workingDirectory(
			this.#host.fs,
			path.resolve(this.workspace.root, request.cwd ?? '.')
		);
		const id = this.#host.randomId();
		const signal = AbortSignal.any([context.signal, this.#lifetime.signal]);
		const disposal = () => this.#disposalCleanup;

		const invocation: StartMessage = {
			version: 1,
			kind: 'start',
			id,
			backend: this.#runtime.backend,
			network: this.#configuration.network,
			command: request.command,
			shell,
			cwd,
			readwritePaths: [...this.#grants.readwritePaths],
			environment: targetEnvironment(
				{
					PATH: SYSTEM_PATH,
					HOME: this.#store.scratch,
					TMPDIR: this.#store.scratch,
					...this.#configuration.environment
				},
				request.env
			),
			readonlyPaths: [...this.#grants.readonlyPaths],
			deniedPaths: await resolverSockets(
				this.#host.environment.platform,
				this.#host.fs
			)
		};

		if (Buffer.byteLength(JSON.stringify(invocation)) > MAX_START_BYTES) {
			throw new InvalidSandboxRequestError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		await this.#store.begin(id);

		const job = this.#createJob({
			entry: this.#runtime.entry,
			request: invocation,
			context: {
				...context,
				signal,
				cleanup: {
					remainingMs: () =>
						context.cleanup.remainingMs() ?? disposal()?.remainingMs(),
					get deadline() {
						return context.cleanup.deadline ?? disposal()?.deadline;
					}
				}
			},
			record: (allocation) => this.#store.record(allocation)
		});

		return this.#runJob(id, job);
	}

	async #runJob(id: string, job: JobRunner): Promise<BackendProcessOutcome> {
		this.#runners.add(job);

		try {
			let outcome: BackendProcessOutcome;

			try {
				outcome = await job.run();
			} catch (error) {
				// Job errors without a completion field happen before the supervisor
				// receives the request, so no target exists.
				if (
					isSandboxError(error) &&
					(!('completion' in error) ||
						error.completion === 'confirmed' ||
						error.completion === 'not-started')
				) {
					try {
						await this.#store.confirmReleased(id);
					} catch (cleanupError) {
						throw new AggregateError(
							[error, cleanupError],
							'MXC process completion was established, but its recovery record could not be removed.',
							{ cause: cleanupError }
						);
					}
				}

				throw error;
			}

			await this.#store.confirmReleased(id);

			return outcome;
		} finally {
			this.#runners.delete(job);
		}
	}

	async #dispose(
		context: SandboxOperationContext,
		pending: PromiseWithResolvers<undefined>
	): Promise<void> {
		try {
			const remainingMs =
				context.cleanup.remainingMs() ?? context.remainingMs();

			for (const job of this.#runners) {
				job.limitCleanup(remainingMs);
			}

			await Promise.allSettled(this.#jobs);
			await this.#store.dispose();
			pending.resolve(undefined);
		} catch (error) {
			pending.reject(error);
		}
	}

	get capabilities(): SandboxCapabilities {
		return this.#capabilities;
	}

	async exec(
		request: ProcessRequest,
		context: BackendProcessContext
	): Promise<BackendProcessOutcome> {
		if (this.#isClosing) {
			throw new SandboxSessionClosingError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		if (request.kind !== 'shell') {
			throw new UnsupportedSandboxCapabilityError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		const shell = this.#shells.get(request.dialect);

		if (shell === undefined) {
			throw new UnsupportedSandboxCapabilityError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		const running = this.#execute(request, context, shell);

		this.#jobs.add(running);

		try {
			return await running;
		} finally {
			this.#jobs.delete(running);
		}
	}

	dispose(context: SandboxOperationContext): Promise<void> {
		if (this.#disposal !== undefined) {
			return this.#disposal;
		}

		const pending = Promise.withResolvers<undefined>();

		this.#disposal = pending.promise;
		this.#isClosing = true;

		try {
			this.#disposalCleanup = context.cleanup;
			this.#lifetime.abort('shutdown');
			void this.#dispose(context, pending);
		} catch (error) {
			pending.reject(error);
		}

		return pending.promise;
	}
}
