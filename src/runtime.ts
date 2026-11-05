import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
	SandboxOpenContext,
	ShellDialect
} from 'pi-bring-your-own-sandbox/api';

import type { MxcConfig } from './config.js';
import { MxcConfigError } from './config.js';
import { assertDisjointPaths } from './paths.js';
import { systemReadonlyPaths } from './platform/system-paths.js';
import { resolveBackend } from './policy.js';

export interface MxcRuntime {
	readonly entry: string;
	readonly workspace: string;
	readonly readonlyPaths: readonly string[];
	readonly shells: ReadonlyMap<ShellDialect, string>;
	readonly backend: 'seatbelt' | 'bubblewrap';
}

async function packageRoot(entry: string): Promise<string> {
	let directory = path.dirname(await realpath(entry));

	for (;;) {
		try {
			await access(path.join(directory, 'package.json'));

			return directory;
		} catch (error) {
			if (!(
				error instanceof Error &&
				'code' in error &&
				error.code === 'ENOENT'
			)) {
				throw error;
			}
		}

		const parent = path.dirname(directory);

		if (parent === directory) {
			throw new MxcConfigError(
				'Cannot resolve a trusted runtime package root.'
			);
		}

		directory = parent;
	}
}

async function trustedPaths(entry: string): Promise<string[]> {
	const sdk = fileURLToPath(import.meta.resolve('@microsoft/mxc-sdk/v1'));
	const requireSdk = createRequire(sdk);
	const modules = [
		entry,
		sdk,
		requireSdk.resolve('koffi'),
		requireSdk.resolve('semver'),
		requireSdk.resolve('node-pty'),
		fileURLToPath(import.meta.resolve('typebox')),
		fileURLToPath(import.meta.resolve('pi-bring-your-own-sandbox/api'))
	];
	const roots = await Promise.all(modules.map((module) => packageRoot(module)));

	return [...roots, await realpath(process.execPath)];
}

async function executable(filename: string): Promise<string> {
	const canonical = await realpath(filename);
	const metadata = await stat(canonical);

	if (!metadata.isFile()) {
		throw new MxcConfigError('MXC shell paths must refer to executable files.');
	}

	await access(canonical, constants.X_OK);

	return canonical;
}

export async function prepareRuntime(
	workspace: string,
	config: MxcConfig,
	context: SandboxOpenContext
): Promise<MxcRuntime> {
	const backend = resolveBackend(process.platform, config.backend);

	if (
		Number(process.versions.node.split('.', 1)[0]) < 24 ||
		(process.platform === 'darwin' && process.arch !== 'arm64')
	) {
		throw new MxcConfigError(
			'The pinned MXC package requires Node 24+ and has macOS native assets for ARM64 only.'
		);
	}

	const canonicalWorkspace = await realpath(workspace);
	const metadata = await stat(canonicalWorkspace);

	if (!metadata.isDirectory()) {
		throw new MxcConfigError('The MXC workspace must be a directory.');
	}

	const entry = await realpath(
		fileURLToPath(new URL('../dist/supervisor/entry.js', import.meta.url))
	);
	const configuredPaths = await Promise.all(
		config.readonlyPaths.map((filename) => realpath(filename))
	);
	const readonlyPaths = [
		...(await systemReadonlyPaths(process.platform)),
		...configuredPaths
	];
	const protectedPaths = await trustedPaths(entry);

	assertDisjointPaths(canonicalWorkspace, [
		...protectedPaths,
		...readonlyPaths
	]);

	const shells = new Map<ShellDialect, string>([
		['sh', await executable(config.shells.sh)]
	]);

	if (config.shells.bash !== undefined) {
		try {
			shells.set('bash', await executable(config.shells.bash));
		} catch {
			context.reportDiagnostic({
				level: 'warning',
				message:
					'The configured Bash executable is unavailable. MXC will offer sh only.'
			});
		}
	}

	return {
		entry,
		workspace: canonicalWorkspace,
		readonlyPaths: [...readonlyPaths, ...shells.values()],
		shells,
		backend
	};
}
