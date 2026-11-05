import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessRequest,
	RecoveryDescriptor,
	SandboxBackend,
	SandboxCapabilities,
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
	SandboxSessionClosingError,
	SandboxStartupError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/api';

import type { MxcConfig } from './config.js';
import { assertDisjointPaths } from './paths.js';
import { EFFECTIVE_POLICY } from './policy.js';
import { RecoveryStore } from './recovery.js';
import type { MxcRuntime } from './runtime.js';
import { prepareRuntime } from './runtime.js';
import { targetEnvironment } from './shell.js';
import type { JobOptions } from './supervisor/client.js';
import { SupervisorJob } from './supervisor/client.js';
import type { StartMessage } from './supervisor/protocol.js';

type JobRunner = Pick<SupervisorJob, 'run' | 'limitCleanup'>;

interface BackendDependencies {
	readonly prepareRuntime: typeof prepareRuntime;
	readonly createJob: (options: JobOptions) => JobRunner;
}

const DEFAULT_DEPENDENCIES: BackendDependencies = Object.freeze({
	prepareRuntime,
	createJob: (options: JobOptions) => new SupervisorJob(options)
});

function capabilities(
	shells: ReadonlyMap<ShellDialect, string>
): SandboxCapabilities {
	return Object.freeze({
		operations: Object.freeze(['exec'] as const),
		processKinds: Object.freeze(['shell'] as const),
		shells: Object.freeze(shells.keys().toArray()),
		exitStatus: 'optional',
		terminationScope: 'process-group'
	});
}

export class MxcBackend implements SandboxBackend {
	static async open(
		request: SandboxOpenRequest<MxcConfig>,
		context: SandboxOpenContext,
		dependencies: BackendDependencies = DEFAULT_DEPENDENCIES
	): Promise<SandboxBackend> {
		let store: RecoveryStore | undefined;

		context.reportRecovery({ kind: 'none' });

		try {
			if (
				request.policy.workspaceAccess !== 'read-write' ||
				request.policy.filesystemScope !== 'provider-default' ||
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

			store = await RecoveryStore.open(runtime.workspace, context);
			assertDisjointPaths(store.scratch, runtime.readonlyPaths);

			const backend = new MxcBackend(
				request,
				runtime,
				store,
				dependencies.createJob
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

			if (context.signal.aborted || context.deadline <= Date.now()) {
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

			context.reportDiagnostic({
				level: 'warning',
				message:
					'MXC opening failed. Check runtime availability, shell/toolchain grants and that the provider is installed outside the writable workspace.'
			});

			context.confirmCleanup();

			throw new SandboxStartupError(
				{ operation: 'open', providerId: 'mxc' },
				{ cause: error }
			);
		}
	}

	readonly #createJob: BackendDependencies['createJob'];
	readonly #runtime: MxcRuntime;
	readonly #configuration: MxcConfig;
	readonly #store: RecoveryStore;
	readonly #shells: Map<ShellDialect, string>;
	readonly #lifetime = new AbortController();
	readonly #jobs = new Set<Promise<BackendProcessOutcome>>();
	readonly #runners = new Set<JobRunner>();
	#capabilities: SandboxCapabilities;
	#isClosing = false;
	#disposalDeadline: number | undefined;
	#disposal: Promise<void> | undefined;
	readonly id: string;
	readonly workspace: SandboxWorkspace;
	readonly policy: SandboxPolicy = EFFECTIVE_POLICY;
	readonly policyDescription: string;
	readonly recovery: RecoveryDescriptor;

	private constructor(
		request: SandboxOpenRequest<MxcConfig>,
		runtime: MxcRuntime,
		store: RecoveryStore,
		createJob: BackendDependencies['createJob']
	) {
		this.#createJob = createJob;
		this.#runtime = runtime;
		this.#configuration = request.configuration;
		this.#store = store;
		this.#shells = new Map(runtime.shells);
		this.#capabilities = capabilities(this.#shells);
		this.id = `mxc:${request.generationId}`;
		this.workspace = Object.freeze({
			root: runtime.workspace,
			pathFlavor: 'posix',
			relationship: 'shared',
			home: store.scratch,
			defaultShell: 'sh',
			description:
				'Shared host workspace; changes persist. Private home/scratch lasts until generation disposal.'
		});
		this.recovery = store.recovery;
		this.policyDescription = `MXC ${runtime.backend}; writable shared workspace and private scratch; baseline host system reads plus explicit read-only toolchains; ${request.configuration.network} external IP mode, with ingress and host-loopback IP denied. Accessible UNIX sockets may contact host services. No general resource quotas. Termination covers only the direct process and original supervised POSIX group. Descendants in other groups or sessions may keep modifying permitted files after completion, cancellation, timeout or disposal, even when their parent waited. Detached submission is not supported.`;
	}

	async #execute(
		request: ProcessRequest & { kind: 'shell' },
		context: BackendProcessContext,
		shell: string
	): Promise<BackendProcessOutcome> {
		const id = randomUUID();
		const signal = AbortSignal.any([context.signal, this.#lifetime.signal]);
		let cleanupDeadline: number | undefined;
		const publishCleanup = () => {
			cleanupDeadline ??=
				context.cleanup.deadline ?? this.#disposalDeadline ?? context.deadline;
		};

		signal.addEventListener('abort', publishCleanup, { once: true });

		if (signal.aborted) {
			publishCleanup();
		}

		const invocation: StartMessage = {
			version: 1,
			kind: 'start',
			id,
			backend: this.#runtime.backend,
			network: this.#configuration.network,
			command: request.command,
			shell,
			cwd: path.resolve(this.workspace.root, request.cwd ?? '.'),
			workspace: this.workspace.root,
			scratch: this.#store.scratch,
			environment: targetEnvironment(
				{
					PATH: '/bin:/usr/bin:/usr/sbin:/sbin',
					HOME: this.#store.scratch,
					TMPDIR: this.#store.scratch,
					...this.#configuration.environment
				},
				request.env
			),
			readonlyPaths: [...this.#runtime.readonlyPaths],
			deadline: context.deadline
		};

		if (Buffer.byteLength(JSON.stringify(invocation)) > 1_048_576) {
			signal.removeEventListener('abort', publishCleanup);

			throw new InvalidSandboxRequestError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		try {
			await this.#store.begin(id);

			const job = this.#createJob({
				entry: this.#runtime.entry,
				request: invocation,
				context: {
					...context,
					signal,
					cleanup: {
						get deadline() {
							return cleanupDeadline;
						}
					}
				},
				record: (allocation) => this.#store.record(allocation)
			});

			return await this.#runJob(id, job);
		} finally {
			signal.removeEventListener('abort', publishCleanup);
		}
	}

	async #runJob(id: string, job: JobRunner): Promise<BackendProcessOutcome> {
		this.#runners.add(job);

		try {
			let outcome: BackendProcessOutcome;

			try {
				outcome = await job.run();
			} catch (error) {
				if (
					isSandboxError(error) &&
					'completion' in error &&
					(error.completion === 'confirmed' ||
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
			const deadline = context.cleanup.deadline ?? context.deadline;

			for (const job of this.#runners) {
				job.limitCleanup(deadline);
			}

			await Promise.allSettled(this.#jobs);

			if (context.signal.aborted || context.deadline <= Date.now()) {
				throw new SandboxCleanupError({
					operation: 'dispose',
					providerId: 'mxc',
					recovery: this.recovery
				});
			}

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
			this.#disposalDeadline = context.cleanup.deadline ?? context.deadline;
			this.#lifetime.abort('shutdown');
			void this.#dispose(context, pending);
		} catch (error) {
			pending.reject(error);
		}

		return pending.promise;
	}
}
