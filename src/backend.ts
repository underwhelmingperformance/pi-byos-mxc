import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type {
	BackendFiles,
	BackendProcessContext,
	BackendProcessOutcome,
	BackendSearch,
	GrantedPath,
	ProcessRequest,
	Profile,
	RecoveryDescriptor,
	SandboxBackend,
	SandboxCleanupContext,
	SandboxCopySource,
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxOperationContext,
	SandboxPolicy,
	SandboxWorkspace
} from 'pi-bring-your-own-sandbox/provider';
import {
	cleanDisplayText,
	InvalidSandboxRequestError,
	isSandboxError,
	mapSandboxErrno,
	resolveSandboxCopySource,
	SandboxCleanupError,
	SandboxPathNotFoundError,
	SandboxSessionClosingError,
	SandboxStartupError,
	ShellTransportRunner,
	StaleSandboxHandleError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/provider';

import type { MxcConfig } from './config.js';
import { copyWorkspace, SnapshotRefusalError } from './copy-workspace.js';
import {
	MxcConfigError,
	ShellStartupError,
	UnenforceablePolicyError
} from './errors.js';
import {
	canonicalGrantPath,
	credentialPaths,
	planPathGrants
} from './grants.js';
import type { Host, HostFileSystem } from './host.js';
import { systemHost } from './host.js';
import { assertDisjointPaths, compareText } from './paths.js';
import type { PlaceholderLease } from './placeholders.js';
import {
	PlaceholderCleanupError,
	PlaceholderRegistry
} from './placeholders.js';
import { resolverSockets } from './platform/system-paths.js';
import { networkMode, profilesFor } from './policy.js';
import type { Protection } from './protection.js';
import { defaultWorkspaceProtection, planProtection } from './protection.js';
import { RecoveryStore } from './recovery.js';
import type { MxcRuntime } from './runtime.js';
import { prepareRuntime, verifyWorkspaceEntries } from './runtime.js';
import { SYSTEM_PATH, targetEnvironment } from './shell.js';
import type { JobOptions } from './supervisor/client.js';
import { SupervisorJob } from './supervisor/client.js';
import type { StartMessage } from './supervisor/protocol.js';
import { MAX_START_BYTES } from './supervisor/protocol.js';
import { sandboxTargetOperations } from './target-operations.js';

const SEATBELT_ROOT_WRITE_EXCEPTIONS = [
	'/dev/null',
	'/dev/zero',
	'/dev/random',
	'/dev/urandom'
];

type JobRunner = Pick<SupervisorJob, 'run' | 'limitCleanup'>;

interface ShellLaunchOptions {
	readonly bootstrap?: true;
	readonly input?: Uint8Array;
}

interface BackendDependencies {
	readonly host: Host;
	readonly prepareRuntime: typeof prepareRuntime;
	readonly createJob: (options: JobOptions) => JobRunner;
}

// Backends on the same host share placeholders, so that one backend cannot
// remove a placeholder that another backend's command still relies on.
const registries = new WeakMap<Host['fs'], PlaceholderRegistry>();

function placeholderRegistry(host: Host): PlaceholderRegistry {
	const existing = registries.get(host.fs);

	if (existing !== undefined) {
		return existing;
	}

	const registry = new PlaceholderRegistry(host.fs);

	registries.set(host.fs, registry);

	return registry;
}

const DEFAULT_DEPENDENCIES: BackendDependencies = Object.freeze({
	host: systemHost,
	prepareRuntime,
	createJob: (options: JobOptions) => new SupervisorJob(options)
});

function describePolicy(
	runtime: MxcRuntime & { readonly protection: Protection },
	policy: SandboxPolicy,
	network: StartMessage['network'],
	isWritable: boolean,
	relationship: 'shared' | 'copied'
): string {
	const isSeatbelt = runtime.backend === 'seatbelt';
	const protectedEntries = [
		...runtime.protection.readonlyPaths,
		...runtime.protection.placeholders
	].toSorted(compareText);
	const socketScope = [
		'in the writable workspace',
		...(isSeatbelt ? [] : ['in read-only grants']),
		...(isSeatbelt && network === 'open-egress' ? ['anywhere on the host'] : [])
	].join(' and ');
	const filesystem =
		policy.hostUserData === 'read-only'
			? 'MXC permits host file reads outside known credential locations. Host writes require a workspace permission or a path grant.'
			: 'MXC permits host system reads and access through listed path grants. Other host user data is denied.';

	return [
		`MXC ${runtime.backend}; ${isWritable ? 'writable' : 'read-only'} ${relationship} workspace and private writable scratch.`,
		filesystem,
		...(protectedEntries.length > 0
			? [
					`Read-only protected workspace entries: ${protectedEntries.join(', ')}.`
				]
			: []),
		...(network === 'denied'
			? [
					'Seatbelt denies IP networking, pathname UNIX socket connections and Mach service lookup.'
				]
			: [
					`${network} external IP mode, with ingress and host-loopback IP denied.`,
					`Commands can connect to host services through UNIX sockets ${socketScope}; those services can make network connections on the command's behalf.`
				]),
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
		throw mapSandboxErrno(error, identity);
	}

	throw new SandboxPathNotFoundError(identity);
}

async function verifyShell(
	backend: SandboxBackend,
	dialect: 'sh' | 'bash',
	command: string,
	context: BackendProcessContext
): Promise<void> {
	let outcome: BackendProcessOutcome;

	try {
		outcome = await backend.exec({ kind: 'shell', dialect, command }, context);
	} catch (error) {
		throw new ShellStartupError(dialect, { cause: error });
	}

	if (
		outcome.kind !== 'exited' ||
		outcome.exit.kind !== 'code' ||
		outcome.exit.code !== 0
	) {
		throw new ShellStartupError(dialect);
	}
}

export class MxcBackend implements SandboxBackend {
	static async open(
		request: SandboxOpenRequest<MxcConfig>,
		context: SandboxOpenContext,
		overrides: Partial<BackendDependencies> = {},
		source?: SandboxCopySource
	): Promise<SandboxBackend> {
		const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
		const relationship = source === undefined ? 'shared' : 'copied';
		let store: RecoveryStore | undefined;

		context.reportRecovery({ kind: 'none' });

		try {
			const platform = dependencies.host.environment.platform;
			const profiles = profilesFor(platform);
			const profile = (
				source === undefined ? profiles.open : profiles.copy
			).find((candidate) =>
				isDeepStrictEqual(candidate.policy, request.profile.policy)
			);

			if (profile === undefined) {
				throw new UnsupportedSandboxPolicyError({
					operation: 'open',
					providerId: 'mxc'
				});
			}

			const { policy } = profile;

			const parent =
				source &&
				resolveSandboxCopySource(
					source,
					(backend): backend is MxcBackend =>
						backend instanceof this &&
						backend.#sessionId === request.sessionId &&
						backend.#hostWorkspace === request.hostWorkspace &&
						backend.#host.fs === dependencies.host.fs &&
						!backend.#lifetime.signal.aborted
				);
			const runtime = await dependencies.prepareRuntime(
				parent?.workspace.root ?? request.hostWorkspace,
				request.configuration,
				policy.hostUserData
			);

			if (
				parent &&
				(parent.#lifetime.signal.aborted ||
					parent.workspace.root !== runtime.workspace ||
					parent.#runtime.backend !== runtime.backend ||
					parent.#runtime.entry !== runtime.entry)
			) {
				throw new StaleSandboxHandleError({
					operation: 'open',
					providerId: 'mxc'
				});
			}

			if (relationship === 'shared') {
				await verifyWorkspaceEntries(
					dependencies.host.fs,
					runtime.workspace,
					context.signal
				);
			}

			store = await RecoveryStore.open(
				runtime.workspace,
				context,
				dependencies.host
			);
			assertDisjointPaths(store.scratch, runtime.readonlyPaths);

			const copyContext = parent
				? {
						...context,
						signal: AbortSignal.any([context.signal, parent.#lifetime.signal])
					}
				: context;
			const workspace =
				source === undefined
					? runtime.workspace
					: await copyWorkspace(
							runtime.entry,
							runtime.workspace,
							store.root,
							copyContext
						);
			const isWritable =
				relationship === 'copied' || policy.hostWorkspaceWrites;
			const protection = await planProtection(dependencies.host, {
				workspace,
				backend: runtime.backend,
				workspaceAccess: isWritable ? 'read-write' : 'read-only',
				...(runtime.backend === 'bubblewrap' && {
					inspectEntry: (filename: string) =>
						placeholderRegistry(dependencies.host).inspect(filename)
				}),
				resources: [
					...defaultWorkspaceProtection(runtime.backend),
					...request.configuration.protectPaths.map((entry) => ({
						kind: 'path' as const,
						path: entry
					}))
				]
			});
			const { fs, environment } = dependencies.host;
			const hostHome = await canonicalGrantPath(fs, environment.homeDirectory);
			const hasHostReads = policy.hostUserData === 'read-only';
			const credentials =
				hasHostReads || request.paths !== undefined
					? await credentialPaths(fs, hostHome)
					: [];
			const grants = await planPathGrants(fs, request, context, {
				hostWorkspace:
					parent === undefined
						? runtime.workspace
						: parent.#canonicalHostWorkspace,
				workspace,
				hostHome,
				targetHome: store.scratch,
				credentials,
				backend: runtime.backend,
				protectedWrites: [
					store.root,
					...runtime.protectedPaths,
					...runtime.readonlyPaths
				],
				policy
			});

			const backend = new MxcBackend(
				request,
				profile,
				{
					...runtime,
					workspace,
					protection,
					...(hasHostReads && { hostUserDataRoot: hostHome })
				},
				store,
				dependencies,
				relationship,
				grants
			);
			const probeContext: BackendProcessContext = {
				...context,
				onOutput() {
					return;
				}
			};

			for (const [dialect, command] of [
				['sh', ':'],
				['bash', '[[ 1 == 1 ]]']
			] as const) {
				await verifyShell(backend, dialect, command, probeContext);
			}

			if (context.signal.aborted) {
				throw new SandboxStartupError({ operation: 'open', providerId: 'mxc' });
			}

			if (parent && parent.#lifetime.signal.aborted) {
				throw new StaleSandboxHandleError({
					operation: 'open',
					providerId: 'mxc'
				});
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
					error instanceof MxcConfigError ||
					error instanceof SnapshotRefusalError
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
	readonly #placeholders: PlaceholderRegistry;
	readonly #protection: Protection;
	readonly #runtime: MxcRuntime;
	readonly #hostWorkspace: string;
	readonly #canonicalHostWorkspace: string;
	readonly #sessionId: string;
	readonly #configuration: MxcConfig;
	readonly #argv: ShellTransportRunner;
	readonly #store: RecoveryStore;
	readonly #grants: Pick<
		StartMessage,
		'readwritePaths' | 'readonlyPaths' | 'deniedPaths' | 'credentialGrants'
	>;
	readonly #network: StartMessage['network'];
	readonly #lifetime = new AbortController();
	readonly #jobs = new Set<Promise<BackendProcessOutcome>>();
	readonly #runners = new Set<JobRunner>();
	readonly #pendingReleases = new Map<
		string,
		{ readonly lease: PlaceholderLease; readonly isRecorded: boolean }
	>();
	#isClosing = false;
	#disposalCleanup: SandboxCleanupContext | undefined;
	#disposal: Promise<void> | undefined;
	readonly id: string;
	readonly workspace: SandboxWorkspace;
	readonly profile: Profile;
	readonly grantedPaths?: readonly GrantedPath[];
	readonly files: Required<BackendFiles>;
	readonly search: BackendSearch;
	readonly policyDescription: string;
	readonly recovery: RecoveryDescriptor;

	private constructor(
		request: SandboxOpenRequest<MxcConfig>,
		profile: Profile,
		runtime: MxcRuntime & {
			readonly protection: Protection;
			readonly hostUserDataRoot?: string;
		},
		store: RecoveryStore,
		dependencies: BackendDependencies,
		relationship: 'shared' | 'copied',
		grants: Awaited<ReturnType<typeof planPathGrants>>
	) {
		this.#host = dependencies.host;
		this.#createJob = dependencies.createJob;
		this.#placeholders = placeholderRegistry(dependencies.host);
		this.#protection = runtime.protection;
		this.#runtime = runtime;
		this.#hostWorkspace = request.hostWorkspace;
		this.#canonicalHostWorkspace = grants.hostWorkspace;
		this.#sessionId = request.sessionId;
		this.#configuration = request.configuration;
		this.#store = store;
		this.profile = profile;
		this.#network = networkMode(runtime.backend, profile.policy);

		if (grants.mappings.length > 0) {
			this.grantedPaths = Object.freeze(
				grants.mappings.map((mapping) => Object.freeze(mapping))
			);
		}

		this.id = `mxc:${request.generationId}:${store.id}`;

		const isWritable =
			relationship === 'copied' || profile.policy.hostWorkspaceWrites;

		this.workspace = Object.freeze({
			root: runtime.workspace,
			pathFlavor: 'posix',
			relationship,
			home: store.scratch,
			...(runtime.hostUserDataRoot !== undefined && {
				hostUserDataRoot: runtime.hostUserDataRoot
			}),
			defaultShell: 'sh',
			description:
				relationship === 'copied'
					? 'Private writable workspace copy. Changes stay in the copy until disposal.'
					: isWritable
						? 'Shared host workspace; changes persist. Private home/scratch lasts until generation disposal.'
						: 'Shared host workspace, read-only inside the sandbox; host changes are visible. Private writable home/scratch lasts until generation disposal.'
		});
		this.recovery = store.recovery;
		this.#argv = new ShellTransportRunner(
			this.workspace.root,
			targetEnvironment(
				this.#defaultEnvironment(),
				this.#configuration.environment
			),
			{
				dialect: 'sh',
				nodeExecutable: this.#host.environment.execPath,
				providerId: 'mxc',
				carrier: {
					run: (request, context) =>
						this.#run(request, context, { bootstrap: true })
				}
			}
		);

		const hasReadOnlyRoot = profile.policy.hostUserData === 'read-only';
		const isGeneratedSeatbelt =
			runtime.backend === 'seatbelt' && this.#network === 'open-egress';

		this.#grants = {
			readwritePaths: [
				store.scratch,
				...grants.extraWrites,
				...(isWritable ? [runtime.workspace, ...runtime.protection.pins] : []),
				...(isGeneratedSeatbelt ? ['/dev/fd'] : []),
				...(hasReadOnlyRoot && isGeneratedSeatbelt
					? SEATBELT_ROOT_WRITE_EXCEPTIONS
					: [])
			],
			readonlyPaths: [
				...(hasReadOnlyRoot ? ['/'] : []),
				...runtime.readonlyPaths,
				...grants.extraReads,
				...(isWritable
					? [
							...runtime.protection.readonlyPaths,
							...runtime.protection.placeholders
						]
					: [runtime.workspace])
			],
			deniedPaths: [...grants.credentialDenies],
			...(this.#network === 'denied' && {
				credentialGrants: grants.credentialGrants
			})
		};

		const operations = sandboxTargetOperations(
			runtime.workspace,
			this.#host.environment.execPath,
			{
				file: (command, context, input) =>
					this.#run({ kind: 'shell', dialect: 'sh', command }, context, {
						bootstrap: true,
						...(input !== undefined && { input })
					}),
				search: (command, context, input) =>
					this.#run(
						{
							kind: 'shell',
							dialect: 'sh',
							command,
							env: { NODE_OPTIONS: '', NODE_PATH: '' }
						},
						context,
						{
							input
						}
					)
			},
			{ providerId: 'mxc', backendId: this.id, recovery: this.recovery }
		);

		this.files = operations.files;
		this.search = operations.search;
		this.policyDescription = describePolicy(
			runtime,
			profile.policy,
			this.#network,
			isWritable,
			relationship
		);
	}

	#defaultEnvironment(): Record<string, string> {
		return {
			PATH: [
				...(this.#network === 'denied'
					? [
							'/Library/Developer/CommandLineTools/usr/bin',
							'/Applications/Xcode.app/Contents/Developer/usr/bin'
						]
					: []),
				SYSTEM_PATH,
				...(this.#runtime.searchDirectories ?? [])
			].join(':'),
			HOME: this.#store.scratch,
			TMPDIR: this.#store.scratch
		};
	}

	async #execute(
		request: ProcessRequest & { kind: 'shell' },
		context: BackendProcessContext,
		shell: string,
		launch?: ShellLaunchOptions
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
			network: this.#network,
			...(this.#grants.credentialGrants !== undefined && {
				credentialGrants: this.#grants.credentialGrants
			}),
			command: request.command,
			shell,
			cwd,
			readwritePaths: [...this.#grants.readwritePaths],
			environment: targetEnvironment(
				{
					...this.#defaultEnvironment(),
					...(!launch?.bootstrap && this.#configuration.environment)
				},
				request.env
			),
			readonlyPaths: [...this.#grants.readonlyPaths],
			deniedPaths: [
				...this.#grants.deniedPaths,
				...(await resolverSockets(
					this.#host.environment.platform,
					this.#host.fs
				))
			]
		};

		if (Buffer.byteLength(JSON.stringify(invocation)) > MAX_START_BYTES) {
			throw new InvalidSandboxRequestError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		const lease = await this.#placeholders.acquire(
			this.#protection.placeholders
		);

		try {
			await this.#store.begin(id, lease.owned);
		} catch (error) {
			try {
				await this.#finish(id, lease, context, false);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					'MXC could not record the job or release its placeholders.',
					{ cause: cleanupError }
				);
			}

			throw error;
		}

		const job = this.#createJob({
			entry: this.#runtime.entry,
			request: invocation,
			...(launch?.input !== undefined && { input: launch.input }),
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

		return this.#runJob(id, job, lease, context);
	}

	// Removing a placeholder detaches its mount inside a running sandbox, so
	// placeholders are released only when the target is known to have stopped.
	async #finish(
		id: string,
		lease: PlaceholderLease,
		context: SandboxOperationContext,
		isRecorded = true
	): Promise<void> {
		this.#pendingReleases.set(id, { lease, isRecorded });

		try {
			await lease.release();
		} catch (error) {
			if (error instanceof PlaceholderCleanupError) {
				for (const residue of error.residues) {
					context.reportDiagnostic({
						level: 'warning',
						message: cleanDisplayText(residue.message).slice(0, 2048)
					});
				}
			}

			throw error;
		}

		if (isRecorded) {
			await this.#store.confirmReleased(id);
		}

		this.#pendingReleases.delete(id);
	}

	async #runJob(
		id: string,
		job: JobRunner,
		lease: PlaceholderLease,
		context: SandboxOperationContext
	): Promise<BackendProcessOutcome> {
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
						await this.#finish(id, lease, context);
					} catch (cleanupError) {
						throw new AggregateError(
							[error, cleanupError],
							'MXC process completion was established, but its recovery state could not be cleared.',
							{ cause: cleanupError }
						);
					}
				}

				throw error;
			}

			await this.#finish(id, lease, context);

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

			const releases = await Promise.allSettled(
				[...this.#pendingReleases].map(([id, { lease, isRecorded }]) =>
					this.#finish(id, lease, context, isRecorded)
				)
			);

			await this.#store.dispose();

			const failures = releases
				.filter((result) => result.status === 'rejected')
				.map(({ reason }): unknown => reason);

			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					'MXC could not release all placeholders during disposal.'
				);
			}

			pending.resolve(undefined);
		} catch (error) {
			pending.reject(error);
		}
	}

	async #run(
		request: ProcessRequest,
		context: BackendProcessContext,
		launch?: ShellLaunchOptions
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

		const shell = this.#runtime.shells.get(request.dialect);

		if (shell === undefined) {
			throw new UnsupportedSandboxCapabilityError({
				operation: 'exec',
				providerId: 'mxc'
			});
		}

		const running = this.#execute(
			request,
			context,
			launch?.bootstrap ? '/bin/sh' : shell,
			launch
		);

		this.#jobs.add(running);

		try {
			return await running;
		} finally {
			this.#jobs.delete(running);
		}
	}

	exec(
		request: ProcessRequest,
		context: BackendProcessContext
	): Promise<BackendProcessOutcome> {
		return request.kind === 'argv'
			? this.#argv.run(request, context)
			: this.#run(request, context);
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
