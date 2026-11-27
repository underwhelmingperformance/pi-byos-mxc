import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
	SandboxPolicy,
	ShellDialect
} from 'pi-bring-your-own-sandbox/provider';
import { cleanDisplayText } from 'pi-bring-your-own-sandbox/provider';

import type { MxcConfig } from './config.js';
import {
	NodeLibraryResolutionError,
	OverlappingPathsError,
	PersonalShellError,
	ShellNotFileError,
	ShellStartupError,
	SpecialWorkspaceEntryError,
	UnsupportedRuntimeError,
	WorkspaceNotDirectoryError
} from './errors.js';
import { canonicalGrantPath } from './grants.js';
import type { Host, HostFileSystem } from './host.js';
import { systemHost } from './host.js';
import { assertDisjointPaths, isPathWithin } from './paths.js';
import { linkedLibraryGrants } from './platform/linked-libraries.js';
import { packageRoot, trustedPackages } from './platform/packages.js';
import { darwinSearchTools } from './platform/search-tools.js';
import { systemReadonlyPaths } from './platform/system-paths.js';
import { resolveBackend } from './policy.js';

export interface MxcRuntime {
	readonly entry: string;
	readonly searchDirectories?: readonly string[];
	readonly workspace: string;
	readonly readonlyPaths: readonly string[];
	readonly protectedPaths: readonly string[];
	readonly shells: ReadonlyMap<ShellDialect, string>;
	readonly backend: 'seatbelt' | 'bubblewrap';
}

export interface RuntimeOptions {
	readonly host: Host;
	readonly supervisor: string;
	readonly searchTools?: typeof darwinSearchTools;
}

const DEFAULT_OPTIONS: RuntimeOptions = Object.freeze({
	host: systemHost,
	searchTools: darwinSearchTools,
	supervisor: fileURLToPath(
		new URL('../dist/supervisor/entry.js', import.meta.url)
	)
});

export async function verifyWorkspaceEntries(
	fs: HostFileSystem,
	workspace: string,
	signal: AbortSignal
): Promise<void> {
	const pending = [workspace];

	for (
		let directory = pending.pop();
		directory !== undefined;
		directory = pending.pop()
	) {
		signal.throwIfAborted();

		const entries = await fs.readDirectoryEntries(directory);

		for (const entry of entries) {
			signal.throwIfAborted();

			if (entry.isDirectory()) {
				pending.push(path.join(directory, entry.name));
				continue;
			}

			if (!entry.isFile() && !entry.isSymbolicLink()) {
				const filename = path.join(directory, entry.name);
				const relative = path.relative(workspace, filename);

				throw new SpecialWorkspaceEntryError(cleanDisplayText(relative));
			}
		}
	}
}

async function executable(
	fs: HostFileSystem,
	filename: string
): Promise<string> {
	const canonical = await fs.realpath(filename);
	const metadata = await fs.stat(canonical);

	if (!metadata.isFile()) {
		throw new ShellNotFileError(canonical);
	}

	await fs.access(canonical, constants.X_OK);

	return canonical;
}

export async function prepareRuntime(
	workspace: string,
	config: MxcConfig,
	hostUserData: SandboxPolicy['hostUserData'] = 'denied',
	options: RuntimeOptions = DEFAULT_OPTIONS
): Promise<MxcRuntime> {
	const { fs, environment } = options.host;
	const backend = resolveBackend(environment.platform, config.backend);

	if (
		Number(environment.nodeVersion.split('.', 1)[0]) < 24 ||
		(environment.platform === 'darwin' && environment.arch !== 'arm64')
	) {
		throw new UnsupportedRuntimeError(
			environment.nodeVersion,
			environment.platform,
			environment.arch
		);
	}

	const canonicalWorkspace = await fs.realpath(workspace);
	const metadata = await fs.stat(canonicalWorkspace);

	if (!metadata.isDirectory()) {
		throw new WorkspaceNotDirectoryError(canonicalWorkspace);
	}

	const entry = await fs.realpath(options.supervisor);
	const readonlyPaths = await systemReadonlyPaths(environment.platform, fs);
	const restrictedHome =
		hostUserData === 'denied'
			? await canonicalGrantPath(fs, environment.homeDirectory)
			: undefined;
	const search =
		environment.platform === 'darwin' && config.environment.PATH === undefined
			? await options.searchTools?.(canonicalWorkspace, restrictedHome)
			: undefined;
	const node = await fs.realpath(environment.execPath);

	assertDisjointPaths(canonicalWorkspace, [node]);

	let nodeLibraries: string[];

	try {
		nodeLibraries = await linkedLibraryGrants(node, {
			platform: environment.platform,
			workspace: canonicalWorkspace,
			inspect: options.host.inspectLinkedLibraries,
			realpath: (filename) => fs.realpath(filename)
		});
	} catch (error) {
		if (error instanceof OverlappingPathsError) {
			throw error;
		}

		throw new NodeLibraryResolutionError({ cause: error });
	}

	const protectedPaths = [
		...(await trustedPackages(
			options.host,
			await packageRoot(options.host, entry)
		)),
		node
	];
	const shells = new Map<ShellDialect, string>();

	for (const dialect of ['sh', 'bash'] as const) {
		let shell: string;

		try {
			shell = await executable(fs, config.shells[dialect]);
		} catch (error) {
			throw new ShellStartupError(dialect, { cause: error });
		}

		if (restrictedHome !== undefined && isPathWithin(restrictedHome, shell)) {
			throw new PersonalShellError(dialect);
		}

		shells.set(dialect, shell);
	}

	assertDisjointPaths(canonicalWorkspace, [
		...protectedPaths,
		...readonlyPaths,
		...shells.values()
	]);

	return {
		entry,
		workspace: canonicalWorkspace,
		protectedPaths,
		...(search && { searchDirectories: search.directories }),
		readonlyPaths: [
			...readonlyPaths,
			...shells.values(),
			node,
			...nodeLibraries,
			...(search?.files ?? [])
		],
		shells,
		backend
	};
}
