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
	InvalidSandboxRequestError,
	isSandboxError,
	SandboxCleanupError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError,
	SandboxSessionClosingError,
	SandboxStartupError,
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
import { sandboxFiles } from './files.js';
import {
	canonicalGrantPath,
	credentialPaths,
	planPathGrants
} from './grants.js';
import type { Host, HostFileSystem } from './host.js';
import { systemHost } from './host.js';
import { assertDisjointPaths, compareText } from './paths.js';
import type { PlaceholderLease } from './placeholders.js';
import { PlaceholderRegistry } from './placeholders.js';
import { resolverSockets } from './platform/system-paths.js';
import { networkMode, profilesFor } from './policy.js';
import type { Protection } from './protection.js';
import { HOST_CONFIGURATION_PROTECTION, planProtection } from './protection.js';
import { RecoveryStore } from './recovery.js';
import type { MxcRuntime } from './runtime.js';
import { prepareRuntime } from './runtime.js';
import { sandboxSearch } from './search.js';
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
	static readonly #live = new Map<string, MxcBackend>();

	static #resolveParent(
		source: SandboxBackend,
		request: SandboxOpenRequest<MxcConfig>,
		host: Host
	): MxcBackend {
		const parent = MxcBackend.#live.get(source.id);

		if (
			!parent ||
			parent !== source ||
			parent.#sessionId !== request.sessionId ||
			parent.#hostWorkspace !== request.hostWorkspace ||
			parent.#host.fs !== host.fs
		) {
			throw new StaleSandboxHandleError({
				operation: 'open',
				providerId: 'mxc'
			});
		}

		return parent;
	}

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
				source?.kind === 'backend'
					? MxcBackend.#resolveParent(
							source.backend,
							request,
							dependencies.host
						)
					: undefined;
			const runtime = await dependencies.prepareRuntime(
				parent?.workspace.root ?? request.hostWorkspace,
				request.configuration
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
				resources: [
					...HOST_CONFIGURATION_PROTECTION,
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
				denied: credentials,
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
				{ ...runtime, workspace, protection },
				store,
				dependencies,
				relationship,
				grants,
				hasHostReads ? credentials : []
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

			MxcBackend.#live.set(backend.id, backend);

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
	readonly #store: RecoveryStore;
	readonly #grants: Pick<
		StartMessage,
		'readwritePaths' | 'readonlyPaths' | 'deniedPaths'
	>;
	readonly #network: StartMessage['network'];
	readonly #lifetime = new AbortController();
	readonly #jobs = new Set<Promise<BackendProcessOutcome>>();
	readonly #runners = new Set<JobRunner>();
	#isClosing = false;
	#disposalCleanup: SandboxCleanupContext | undefined;
	#disposal: Promise<void> | undefined;
	readonly id: string;
	readonly workspace: SandboxWorkspace;
	readonly profile: Profile;
	readonly grantedPaths?: readonly GrantedPath[];
	readonly files: BackendFiles;
	readonly search: BackendSearch;
	readonly policyDescription: string;
	readonly recovery: RecoveryDescriptor;

	private constructor(
		request: SandboxOpenRequest<MxcConfig>,
		profile: Profile,
		runtime: MxcRuntime & {
			readonly protection: Protection;
		},
		store: RecoveryStore,
		dependencies: BackendDependencies,
		relationship: 'shared' | 'copied',
		grants: Awaited<ReturnType<typeof planPathGrants>>,
		deniedPaths: readonly string[]
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
			defaultShell: 'sh',
			description:
				relationship === 'copied'
					? 'Private writable workspace copy. Changes stay in the copy until disposal.'
					: isWritable
						? 'Shared host workspace; changes persist. Private home/scratch lasts until generation disposal.'
						: 'Shared host workspace, read-only inside the sandbox; host changes are visible. Private writable home/scratch lasts until generation disposal.'
		});
		this.recovery = store.recovery;
		this.#grants = {
			readwritePaths: [
				store.scratch,
				...grants.extraWrites,
				...(isWritable ? [runtime.workspace, ...runtime.protection.pins] : [])
			],
			readonlyPaths: [
				...(profile.policy.hostUserData === 'read-only' ? ['/'] : []),
				...runtime.readonlyPaths,
				...grants.extraReads,
				...(isWritable
					? [
							...runtime.protection.readonlyPaths,
							...runtime.protection.placeholders
						]
					: [runtime.workspace])
			],
			deniedPaths: [...deniedPaths]
		};

		const helper = path.resolve(path.dirname(runtime.entry), '../native/files');

		this.files = sandboxFiles(
			runtime.workspace,
			helper,
			(command, context, input) =>
				this.#run({ kind: 'shell', dialect: 'sh', command }, context, {
					helper,
					...(input !== undefined && { input })
				})
		);

		const worker = path.resolve(
			path.dirname(runtime.entry),
			'../tools/search.js'
		);

		this.search = sandboxSearch(
			this.#host.environment.execPath,
			worker,
			(command, context) =>
				this.#run({ kind: 'shell', dialect: 'sh', command }, context, {
					helper: worker
				})
		);
		this.policyDescription = describePolicy(
			runtime,
			profile.policy,
			this.#network,
			isWritable,
			relationship
		);
	}

	async #execute(
		request: ProcessRequest & { kind: 'shell' },
		context: BackendProcessContext,
		shell: string,
		internal?: { helper: string; input?: Uint8Array }
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
			command: request.command,
			shell,
			cwd,
			readwritePaths: [...this.#grants.readwritePaths],
			environment: targetEnvironment(
				{
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
					TMPDIR: this.#store.scratch,
					...(internal === undefined && this.#configuration.environment)
				},
				request.env
			),
			readonlyPaths: [
				...this.#grants.readonlyPaths,
				...(internal ? [internal.helper] : [])
			],
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
			await this.#store.begin(id, lease.created);
		} catch (error) {
			await lease.release();

			throw error;
		}

		const job = this.#createJob({
			entry: this.#runtime.entry,
			request: invocation,
			...(internal?.input !== undefined && { input: internal.input }),
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

		return this.#runJob(id, job, lease);
	}

	// Removing a placeholder detaches its mount inside a running sandbox, so
	// placeholders are released only when the target is known to have stopped.
	async #finish(id: string, lease: PlaceholderLease): Promise<void> {
		await lease.release();
		await this.#store.confirmReleased(id);
	}

	async #runJob(
		id: string,
		job: JobRunner,
		lease: PlaceholderLease
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
						await this.#finish(id, lease);
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

			await this.#finish(id, lease);

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

	async #run(
		request: ProcessRequest,
		context: BackendProcessContext,
		internal?: { helper: string; input?: Uint8Array }
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
			internal ? '/bin/sh' : shell,
			internal
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
		return this.#run(request, context);
	}

	dispose(context: SandboxOperationContext): Promise<void> {
		if (this.#disposal !== undefined) {
			return this.#disposal;
		}

		MxcBackend.#live.delete(this.id);

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
