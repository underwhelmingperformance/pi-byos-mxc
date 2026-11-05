import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
	SandboxOpenContext,
	ShellDialect
} from 'pi-bring-your-own-sandbox/api';

import type { MxcConfig } from './config.js';
import {
	ShellNotFileError,
	UnsupportedRuntimeError,
	WorkspaceNotDirectoryError
} from './errors.js';
import type { Host, HostFileSystem } from './host.js';
import { systemHost } from './host.js';
import { assertDisjointPaths } from './paths.js';
import { packageRoot, trustedPackages } from './platform/packages.js';
import { systemReadonlyPaths } from './platform/system-paths.js';
import { resolveBackend } from './policy.js';

export interface MxcRuntime {
	readonly entry: string;
	readonly workspace: string;
	readonly readonlyPaths: readonly string[];
	/**
	Canonical grants and shells from the MXC settings.
	*/
	readonly configuredPaths: readonly string[];
	readonly shells: ReadonlyMap<ShellDialect, string>;
	readonly backend: 'seatbelt' | 'bubblewrap';
}

export interface RuntimeOptions {
	readonly host: Host;
	readonly supervisor: string;
}

const DEFAULT_OPTIONS: RuntimeOptions = Object.freeze({
	host: systemHost,
	supervisor: fileURLToPath(
		new URL('../dist/supervisor/entry.js', import.meta.url)
	)
});

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
	context: SandboxOpenContext,
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
	const configuredPaths = await Promise.all(
		config.readonlyPaths.map((filename) => fs.realpath(filename))
	);
	const readonlyPaths = [
		...(await systemReadonlyPaths(environment.platform, fs)),
		...configuredPaths
	];
	const protectedPaths = [
		...(await trustedPackages(
			options.host,
			await packageRoot(options.host, entry)
		)),
		await fs.realpath(environment.execPath)
	];
	const shells = new Map<ShellDialect, string>([
		['sh', await executable(fs, config.shells.sh)]
	]);

	if (config.shells.bash !== undefined) {
		try {
			shells.set('bash', await executable(fs, config.shells.bash));
		} catch {
			context.reportDiagnostic({
				level: 'warning',
				message:
					'The configured Bash executable is unavailable. MXC will offer sh only.'
			});
		}
	}

	assertDisjointPaths(canonicalWorkspace, [
		...protectedPaths,
		...readonlyPaths,
		...shells.values()
	]);

	return {
		entry,
		workspace: canonicalWorkspace,
		readonlyPaths: [...readonlyPaths, ...shells.values()],
		configuredPaths: [...configuredPaths, ...shells.values()],
		shells,
		backend
	};
}
