/**
Base class for problems with the MXC settings or the host environment. The
backend reports their messages to the user when opening fails.
*/
export abstract class MxcConfigError extends Error {}

export class InvalidSettingsError extends MxcConfigError {
	override readonly name = 'InvalidSettingsError';

	/**
	JSON pointers to the invalid settings. `''` refers to the whole value.
	*/
	readonly paths: readonly string[];

	constructor(paths: readonly string[]) {
		super(
			paths.includes('')
				? 'The MXC settings must be an object.'
				: `Invalid MXC settings at ${paths.join(', ')}. Check the backend, protected paths, shell paths and environment values.`
		);
		this.paths = paths;
	}
}

export class SettingsFileSyntaxError extends MxcConfigError {
	override readonly name = 'SettingsFileSyntaxError';
	readonly file: string;

	constructor(file: string, options: ErrorOptions) {
		super(`The MXC settings file ${file} is not valid JSON.`, options);
		this.file = file;
	}
}

export class InvalidSettingsFileError extends MxcConfigError {
	override readonly name = 'InvalidSettingsFileError';
	readonly file: string;

	/**
	JSON pointers to the invalid settings. `''` refers to the whole file.
	*/
	readonly paths: readonly string[];

	constructor(file: string, paths: readonly string[]) {
		super(
			paths.includes('')
				? `The MXC settings file ${file} must contain a JSON object.`
				: `The MXC settings file ${file} has invalid values at ${paths.join(', ')}.`
		);
		this.file = file;
		this.paths = paths;
	}
}

export class UnsupportedBackendError extends MxcConfigError {
	override readonly name = 'UnsupportedBackendError';
	readonly platform: NodeJS.Platform;
	readonly selection: string;

	constructor(platform: NodeJS.Platform, selection: string) {
		super(
			`MXC cannot use the ${selection} backend on ${platform}. It requires Seatbelt on macOS or Bubblewrap on Linux.`
		);
		this.platform = platform;
		this.selection = selection;
	}
}

export class UnsupportedRuntimeError extends MxcConfigError {
	override readonly name = 'UnsupportedRuntimeError';
	readonly nodeVersion: string;
	readonly platform: NodeJS.Platform;
	readonly arch: NodeJS.Architecture;

	constructor(
		nodeVersion: string,
		platform: NodeJS.Platform,
		arch: NodeJS.Architecture
	) {
		super(
			`The pinned MXC package requires Node 24+ and has macOS native assets for ARM64 only. This host runs Node ${nodeVersion} on ${platform} ${arch}.`
		);
		this.nodeVersion = nodeVersion;
		this.platform = platform;
		this.arch = arch;
	}
}

export class OverlappingPathsError extends MxcConfigError {
	override readonly name = 'OverlappingPathsError';
	readonly writable: string;
	readonly protectedPath: string;

	constructor(writable: string, protectedPath: string) {
		super(
			`The writable path ${writable} overlaps ${protectedPath}. Keep the workspace and scratch directories separate from trusted runtime files, recovery metadata, shells and read-only grants.`
		);
		this.writable = writable;
		this.protectedPath = protectedPath;
	}
}

export class WorkspaceNotDirectoryError extends MxcConfigError {
	override readonly name = 'WorkspaceNotDirectoryError';
	readonly workspace: string;

	constructor(workspace: string) {
		super(`The MXC workspace ${workspace} is not a directory.`);
		this.workspace = workspace;
	}
}

export class ShellNotFileError extends MxcConfigError {
	override readonly name = 'ShellNotFileError';
	readonly shell: string;

	constructor(shell: string) {
		super(`The MXC shell ${shell} is not a regular file.`);
		this.shell = shell;
	}
}

export class ResolverNotFileError extends MxcConfigError {
	override readonly name = 'ResolverNotFileError';
	readonly resolver: string;

	constructor(resolver: string) {
		super(
			`The system DNS resolver configuration ${resolver} is not a regular file.`
		);
		this.resolver = resolver;
	}
}

export class PackageRootNotFoundError extends MxcConfigError {
	override readonly name = 'PackageRootNotFoundError';
	readonly entry: string;

	constructor(entry: string) {
		super(`No package.json contains the MXC runtime file ${entry}.`);
		this.entry = entry;
	}
}

export class InvalidPackageManifestError extends MxcConfigError {
	override readonly name = 'InvalidPackageManifestError';
	readonly packageRoot: string;

	constructor(packageRoot: string) {
		super(
			`The package manifest in ${packageRoot} has invalid dependency fields.`
		);
		this.packageRoot = packageRoot;
	}
}

export class AllocationCancelledError extends Error {
	override readonly name = 'AllocationCancelledError';

	constructor() {
		super('MXC opening was cancelled before allocation.');
	}
}

export class InvalidJobIdError extends Error {
	override readonly name = 'InvalidJobIdError';
	readonly id: string;

	constructor(id: string) {
		super(
			`The recovery job ID ${JSON.stringify(id)} must contain only lowercase letters, digits and hyphens.`
		);
		this.id = id;
	}
}

export class UnregisteredJobError extends Error {
	override readonly name = 'UnregisteredJobError';
	readonly id: string;

	constructor(id: string) {
		super(
			`The recovery job ${id} must be registered before its identity is updated.`
		);
		this.id = id;
	}
}

export class ProcessTableUnavailableError extends Error {
	override readonly name = 'ProcessTableUnavailableError';
	readonly candidates: readonly string[];

	constructor(candidates: readonly string[]) {
		super(`ps is not available at ${candidates.join(', ')}.`);
		this.candidates = candidates;
	}
}

export class ControlChannelClosedError extends Error {
	override readonly name = 'ControlChannelClosedError';

	constructor() {
		super('The MXC supervisor control channel is closed.');
	}
}

export class MissingStandardStreamsError extends Error {
	override readonly name = 'MissingStandardStreamsError';

	constructor() {
		super('MXC did not expose the required standard streams.');
	}
}

export class StopNotAcknowledgedError extends Error {
	override readonly name = 'StopNotAcknowledgedError';

	constructor() {
		super('MXC could not acknowledge the stop request.');
	}
}

/**
Base class for policy requirements that the backend cannot enforce. The backend
rejects the policy and reports the message to the user.
*/
export abstract class UnenforceablePolicyError extends Error {}

export class ShellStartupError extends MxcConfigError {
	override readonly name = 'ShellStartupError';

	constructor(dialect: 'sh' | 'bash', options?: ErrorOptions) {
		super(
			`MXC could not start the ${dialect} shell. Check shells.${dialect} in mxc-sandbox.json.`,
			options
		);
	}
}

export class ProtectedSymbolicLinkError extends UnenforceablePolicyError {
	override readonly name = 'ProtectedSymbolicLinkError';
	readonly path: string;

	constructor(path: string) {
		super(
			`Bubblewrap cannot protect the symbolic link ${path}, because it binds the link's target and leaves the link itself replaceable.`
		);
		this.path = path;
	}
}

export class ProtectedHardLinkError extends UnenforceablePolicyError {
	override readonly name = 'ProtectedHardLinkError';
	readonly path: string;

	constructor(path: string) {
		super(
			`The protected file ${path} has another hard link, which a sandboxed command could modify. Replace the hard link with a copy.`
		);
		this.path = path;
	}
}

export class UncoveredProtectedPathError extends UnenforceablePolicyError {
	override readonly name = 'UncoveredProtectedPathError';
	readonly path: string;
	readonly topLevel: string;

	constructor(path: string, topLevel: string) {
		super(
			`${path} must be protected, but a sandboxed command could rename the writable directory that contains it. Add ${topLevel} to the protected resources.`
		);
		this.path = path;
		this.topLevel = topLevel;
	}
}

export class GitMetadataUnavailableError extends UnenforceablePolicyError {
	override readonly name = 'GitMetadataUnavailableError';
	readonly workspace: string;

	constructor(workspace: string, options?: ErrorOptions) {
		super(
			`Git could not report the repository metadata for ${workspace}, so its hooks and configuration includes cannot be protected.`,
			options
		);
		this.workspace = workspace;
	}
}

export class GitUnavailableError extends Error {
	override readonly name = 'GitUnavailableError';

	constructor(options?: ErrorOptions) {
		super('Git is not installed on the host.', options);
	}
}

export class GitCommandError extends Error {
	override readonly name = 'GitCommandError';
	readonly arguments: readonly string[];
	readonly exitCode: number | undefined;
	readonly stderr: string;

	constructor(
		commandArguments: readonly string[],
		exitCode: number | undefined,
		stderr: string,
		options?: ErrorOptions
	) {
		super(
			`git ${commandArguments.join(' ')} failed${exitCode === undefined ? '' : ` with exit code ${String(exitCode)}`}.`,
			options
		);
		this.arguments = commandArguments;
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}
