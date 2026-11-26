import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { GitCommandError, GitUnavailableError } from './errors.js';

interface FileMetadata {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly nlink: number;
	isDirectory(): boolean;
	isFile(): boolean;
	isSocket(): boolean;
	isSymbolicLink(): boolean;
}

/**
The host filesystem operations that the provider performs outside the sandbox.
*/
export interface HostFileSystem {
	access(filename: string, mode?: number): Promise<void>;
	mkdir(
		directory: string,
		options: { readonly mode: number; readonly recursive?: boolean }
	): Promise<unknown>;
	readFile(filename: string, encoding: 'utf8'): Promise<string>;
	realpath(filename: string): Promise<string>;
	rename(source: string, destination: string): Promise<void>;
	rm(
		filename: string,
		options: { readonly recursive: boolean; readonly force: boolean }
	): Promise<void>;
	lstat(filename: string): Promise<FileMetadata>;
	readdir(directory: string): Promise<string[]>;
	readlink(filename: string): Promise<string>;
	stat(filename: string): Promise<FileMetadata>;
	symlink(target: string, filename: string): Promise<void>;
	unlink(filename: string): Promise<void>;
	writeFile(
		filename: string,
		data: string,
		options: { readonly flag: string; readonly mode: number }
	): Promise<void>;
}

/**
The host process properties that decide runtime compatibility and allocation
locations.
*/
export interface HostEnvironment {
	readonly platform: NodeJS.Platform;
	readonly arch: NodeJS.Architecture;
	readonly nodeVersion: string;
	readonly execPath: string;
	readonly temporaryDirectory: string;
	readonly homeDirectory: string;
}

/**
Side effects that the provider performs on the host. Tests replace them with
in-memory implementations.
*/
export interface Host {
	readonly fs: HostFileSystem;
	readonly environment: HostEnvironment;
	readonly randomId: () => string;

	/**
	Returns the canonical directory of the package that Node uses for
	`specifier` from the file `base`. A bare specifier resolves an installed
	package. An absolute path finds the package that contains that file.
	Returns `undefined` when Node cannot resolve the specifier or when no
	`package.json` contains the file.
	*/
	readonly packageDirectory: (
		specifier: string,
		base: string
	) => Promise<string | undefined>;

	/**
	Runs host Git in `directory` and returns its standard output. Rejects with
	`GitUnavailableError` when Git is not installed, and with `GitCommandError`
	when Git fails or exits with a nonzero status.
	*/
	readonly git: (directory: string, gitArguments: string[]) => Promise<string>;
}

// Inherited GIT_* variables, such as GIT_DIR in a hook, would make Git report
// on another repository.
function gitEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
	);
}

function git(directory: string, gitArguments: string[]): Promise<string> {
	const commandArguments = [
		'-C',
		directory,
		'-c',
		'core.fsmonitor=false',
		...gitArguments
	];

	return new Promise((resolve, reject) => {
		execFile(
			'git',
			commandArguments,
			{
				env: gitEnvironment(),
				encoding: 'utf8',
				maxBuffer: 4_194_304,
				timeout: 10_000
			},
			(error, stdout, stderr) => {
				if (error === null) {
					resolve(stdout);

					return;
				}

				if (error.code === 'ENOENT') {
					reject(new GitUnavailableError({ cause: error }));

					return;
				}

				reject(
					new GitCommandError(
						gitArguments,
						typeof error.code === 'number' ? error.code : undefined,
						stderr,
						{ cause: error }
					)
				);
			}
		);
	});
}

async function packageDirectory(
	specifier: string,
	base: string
): Promise<string | undefined> {
	try {
		const manifest = findPackageJSON(
			path.isAbsolute(specifier) ? pathToFileURL(specifier) : specifier,
			pathToFileURL(base)
		);

		// Node 24.22.2 returns the file itself when none of its ancestor
		// directories contains a `package.json`.
		return manifest === undefined || path.basename(manifest) !== 'package.json'
			? undefined
			: path.dirname(await fs.realpath(manifest));
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			error.code === 'ERR_MODULE_NOT_FOUND'
		) {
			return undefined;
		}

		throw error;
	}
}

export const systemHost: Host = Object.freeze({
	fs,
	environment: Object.freeze({
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.versions.node,
		execPath: process.execPath,
		temporaryDirectory: tmpdir(),
		homeDirectory: homedir()
	}),
	randomId: randomUUID,
	packageDirectory,
	git
});
