import path from 'node:path';

import type { WorkspaceProtection } from 'pi-bring-your-own-sandbox/api';

import {
	GitCommandError,
	GitMetadataUnavailableError,
	GitUnavailableError,
	ProtectedHardLinkError,
	ProtectedPathAbsentError,
	ProtectedSymbolicLinkError,
	UncoveredProtectedPathError
} from './errors.js';
import type { Host } from './host.js';
import { compareText, isPathWithin } from './paths.js';

export interface ProtectionRequest {
	/**
	The canonical host workspace.
	*/
	readonly workspace: string;
	readonly backend: 'seatbelt' | 'bubblewrap';
	readonly workspaceAccess: 'read-only' | 'read-write';
	readonly resources: readonly WorkspaceProtection[];
}

const GIT_PATHS = [
	'rev-parse',
	'--path-format=absolute',
	'--git-dir',
	'--git-common-dir',
	'--git-path',
	'hooks'
];
const GIT_INCLUDES = [
	'config',
	'--show-origin',
	'--null',
	'--get-regexp',
	String.raw`^include(if\..+)?\.path$`
];

function isMissing(error: unknown): boolean {
	return (
		error instanceof Error &&
		'code' in error &&
		(error.code === 'ENOENT' || error.code === 'ENOTDIR')
	);
}

class ProtectionPlan {
	readonly #host: Host;
	readonly #request: ProtectionRequest;
	readonly #entries = new Set<string>();

	constructor(host: Host, request: ProtectionRequest) {
		this.#host = host;
		this.#request = request;
	}

	// A sandboxed command can rename any writable directory, which replaces
	// everything inside it. The workspace root cannot be renamed, so protection
	// is only effective for its direct entries and their contents.
	#topLevel(filename: string): string {
		const [first = ''] = path
			.relative(this.#request.workspace, filename)
			.split(path.sep);

		return path.join(this.#request.workspace, first);
	}

	#isWritable(filename: string): boolean {
		return isPathWithin(this.#request.workspace, filename);
	}

	#require(filename: string): void {
		if (!this.#isWritable(filename)) {
			return;
		}

		const topLevel = this.#topLevel(filename);

		if ([...this.#entries].every((entry) => !isPathWithin(entry, filename))) {
			throw new UncoveredProtectedPathError(filename, topLevel);
		}
	}

	async #exists(filename: string): Promise<boolean> {
		try {
			await this.#host.fs.lstat(filename);

			return true;
		} catch (error) {
			if (isMissing(error)) {
				return false;
			}

			throw error;
		}
	}

	async #gitPaths(): Promise<string[]> {
		const { workspace } = this.#request;

		try {
			const output = await this.#host.git(workspace, GIT_PATHS);

			return output.split('\n').filter((line) => line !== '');
		} catch (error) {
			const isRepository = await this.#exists(path.join(workspace, '.git'));

			const isOutsideRepository =
				error instanceof GitUnavailableError ||
				(error instanceof GitCommandError && error.exitCode === 128);

			if (!isRepository && isOutsideRepository) {
				return [];
			}

			throw new GitMetadataUnavailableError(workspace, { cause: error });
		}
	}

	async #gitIncludes(): Promise<string[]> {
		const { workspace } = this.#request;
		let output: string;

		try {
			output = await this.#host.git(workspace, GIT_INCLUDES);
		} catch (error) {
			// `git config --get-regexp` exits with status 1 when nothing matches.
			if (error instanceof GitCommandError && error.exitCode === 1) {
				return [];
			}

			throw new GitMetadataUnavailableError(workspace, { cause: error });
		}

		const fields = output.split('\0');
		const targets: string[] = [];

		for (let index = 0; index + 1 < fields.length; index += 2) {
			const origin = fields[index] ?? '';
			const [, value = ''] = (fields[index + 1] ?? '').split('\n', 2);
			const target = this.#includeTarget(origin, value);

			if (target !== undefined) {
				targets.push(target);
			}
		}

		return targets;
	}

	// Git resolves `~/` against the home directory and other relative include
	// paths against the directory of the file that contains the directive.
	#includeTarget(origin: string, value: string): string | undefined {
		if (!origin.startsWith('file:') || value.startsWith('%(prefix)/')) {
			return undefined;
		}

		if (value.startsWith('~/')) {
			return path.join(this.#host.environment.homeDirectory, value.slice(2));
		}

		const file = path.resolve(this.#request.workspace, origin.slice(5));

		return path.resolve(path.dirname(file), value);
	}

	async #addGitMetadata(): Promise<string[]> {
		this.#entries.add(path.join(this.#request.workspace, '.git'));

		const repository = await this.#gitPaths();

		if (repository.length === 0) {
			return [];
		}

		const discovered = [...repository, ...(await this.#gitIncludes())].filter(
			(filename) => this.#isWritable(filename)
		);

		for (const filename of discovered) {
			const topLevel = this.#topLevel(filename);

			if (filename === topLevel) {
				this.#entries.add(filename);
			}
		}

		return discovered;
	}

	async #inspectTree(directory: string): Promise<void> {
		const names = await this.#host.fs.readdir(directory);

		for (const name of names) {
			await this.#inspectEntry(path.join(directory, name));
		}
	}

	async #inspectLink(link: string): Promise<void> {
		const target = path.resolve(
			path.dirname(link),
			await this.#host.fs.readlink(link)
		);

		try {
			this.#require(await this.#host.fs.realpath(target));
		} catch (error) {
			if (!isMissing(error)) {
				throw error;
			}

			this.#require(target);
		}
	}

	async #inspectEntry(filename: string): Promise<void> {
		const metadata = await this.#host.fs.lstat(filename);

		if (metadata.isSymbolicLink()) {
			await this.#inspectLink(filename);

			return;
		}

		if (metadata.isDirectory()) {
			await this.#inspectTree(filename);

			return;
		}

		if (metadata.isFile() && metadata.nlink > 1) {
			throw new ProtectedHardLinkError(filename);
		}
	}

	async #inspectTopLevel(entry: string): Promise<void> {
		const isBubblewrap = this.#request.backend === 'bubblewrap';

		if (!(await this.#exists(entry))) {
			if (isBubblewrap) {
				throw new ProtectedPathAbsentError(entry);
			}

			return;
		}

		const metadata = await this.#host.fs.lstat(entry);

		if (isBubblewrap && metadata.isSymbolicLink()) {
			throw new ProtectedSymbolicLinkError(entry);
		}

		await this.#inspectEntry(entry);
	}

	async build(): Promise<string[]> {
		const required: string[] = [];

		for (const resource of this.#request.resources) {
			if (resource.kind === 'git-metadata') {
				required.push(...(await this.#addGitMetadata()));

				continue;
			}

			const filename = path.join(this.#request.workspace, resource.path);

			required.push(filename);

			if (filename === this.#topLevel(filename)) {
				this.#entries.add(filename);
			}
		}

		for (const filename of required) {
			this.#require(filename);
		}

		const entries = [...this.#entries].toSorted(compareText);

		for (const entry of entries) {
			await this.#inspectTopLevel(entry);
		}

		return entries;
	}
}

/**
Returns the workspace entries to grant read-only so that sandboxed commands
cannot change the requested resources. Rejects with an
`UnenforceablePolicyError` subclass when the backend cannot keep a resource
immutable.

Each protected path must be a direct entry of the workspace or lie inside one.
A protected tree must not contain hard-linked files or symbolic links to
writable workspace files. Bubblewrap mounts over existing paths only, so it also
requires each entry to exist and not be a symbolic link.
*/
export async function protectedPaths(
	host: Host,
	request: ProtectionRequest
): Promise<string[]> {
	return request.workspaceAccess === 'read-only' ||
		request.resources.length === 0
		? []
		: new ProtectionPlan(host, request).build();
}
