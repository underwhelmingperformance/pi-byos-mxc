import path from 'node:path';

import {
	GitCommandError,
	GitMetadataUnavailableError,
	GitUnavailableError,
	ProtectedHardLinkError,
	ProtectedSymbolicLinkError,
	UncoveredProtectedPathError
} from './errors.js';
import type { Host } from './host.js';
import { compareText, isPathWithin } from './paths.js';

export type WorkspaceProtection =
	| { readonly kind: 'git-metadata' }
	| { readonly kind: 'path'; readonly path: string };

export const HOST_CONFIGURATION_PROTECTION: readonly WorkspaceProtection[] =
	Object.freeze([
		Object.freeze({ kind: 'git-metadata' as const }),
		...['.pi', '.envrc', '.direnv', '.vscode', '.idea', '.devcontainer'].map(
			(path) => Object.freeze({ kind: 'path' as const, path })
		)
	]);

export interface ProtectionRequest {
	/**
	The canonical host workspace.
	*/
	readonly workspace: string;
	readonly backend: 'seatbelt' | 'bubblewrap';
	readonly workspaceAccess: 'read-only' | 'read-write';
	readonly resources: readonly WorkspaceProtection[];
}

/**
How to keep the requested resources immutable for one backend.
*/
export interface Protection {
	/**
	Existing paths, or literal absent paths with Seatbelt, to grant read-only.
	*/
	readonly readonlyPaths: readonly string[];

	/**
	Absent paths to cover with an empty read-only placeholder file before each
	Bubblewrap command.
	*/
	readonly placeholders: readonly string[];

	/**
	Existing directories to grant read-write as separate mounts, so that a
	sandboxed command cannot rename them and replace a protected path inside.
	*/
	readonly pins: readonly string[];
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
	readonly #readonly = new Set<string>();
	readonly #placeholders = new Set<string>();
	readonly #pins = new Set<string>();

	constructor(host: Host, request: ProtectionRequest) {
		this.#host = host;
		this.#request = request;
	}

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

	async #gitMetadata(): Promise<string[]> {
		const repository = await this.#gitPaths();

		if (repository.length === 0) {
			return [path.join(this.#request.workspace, '.git')];
		}

		const discovered = [...repository, ...(await this.#gitIncludes())].filter(
			(filename) => this.#isWritable(filename)
		);

		return [path.join(this.#request.workspace, '.git'), ...discovered];
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

	async #metadata(filename: string) {
		try {
			return await this.#host.fs.lstat(filename);
		} catch (error) {
			if (isMissing(error)) {
				return;
			}

			throw error;
		}
	}

	// Seatbelt matches literal paths, so it protects absent entries directly.
	async #protectWithSeatbelt(entry: string): Promise<void> {
		const metadata = await this.#metadata(entry);

		this.#readonly.add(entry);

		if (metadata !== undefined) {
			await this.#inspectEntry(entry);
		}
	}

	// Bubblewrap mounts only over existing paths and follows symbolic links.
	// Each existing ancestor becomes its own mount so that it cannot be
	// renamed, and the first missing component gets an empty placeholder.
	async #protectWithBubblewrap(entry: string): Promise<void> {
		const components = path
			.relative(this.#request.workspace, entry)
			.split(path.sep);
		let current = this.#request.workspace;

		for (const [index, component] of components.entries()) {
			current = path.join(current, component);

			const metadata = await this.#metadata(current);

			if (metadata === undefined) {
				this.#placeholders.add(current);

				return;
			}

			if (metadata.isSymbolicLink()) {
				throw new ProtectedSymbolicLinkError(current);
			}

			if (index < components.length - 1) {
				this.#pins.add(current);
			}
		}

		this.#readonly.add(entry);
		await this.#inspectEntry(entry);
	}

	// A sandboxed command can rename any writable directory, which replaces
	// everything inside it. Bubblewrap pins the directories above each
	// protected path, but Seatbelt cannot stop the rename, so its protection is
	// only effective for direct workspace entries and their contents.
	#entriesFor(required: readonly string[]): string[] {
		return required.filter(
			this.#request.backend === 'bubblewrap'
				? (filename) =>
						required.every(
							(other) => other === filename || !isPathWithin(other, filename)
						)
				: (filename) => filename === this.#topLevel(filename)
		);
	}

	async build(): Promise<Protection> {
		const required: string[] = [];

		for (const resource of this.#request.resources) {
			if (resource.kind === 'git-metadata') {
				required.push(...(await this.#gitMetadata()));

				continue;
			}

			required.push(path.join(this.#request.workspace, resource.path));
		}

		const entries = [...new Set(this.#entriesFor(required))].toSorted(
			compareText
		);

		for (const entry of entries) {
			this.#entries.add(entry);
		}

		for (const filename of required) {
			this.#require(filename);
		}

		for (const entry of entries) {
			await (this.#request.backend === 'bubblewrap'
				? this.#protectWithBubblewrap(entry)
				: this.#protectWithSeatbelt(entry));
		}

		return {
			readonlyPaths: [...this.#readonly].toSorted(compareText),
			placeholders: [...this.#placeholders].toSorted(compareText),
			pins: [...this.#pins]
				.filter((pin) => !this.#readonly.has(pin))
				.toSorted(compareText)
		};
	}
}

/**
Plans how to keep the requested resources immutable. Rejects with an
`UnenforceablePolicyError` subclass when the backend cannot do so.

A protected tree must not contain hard-linked files or symbolic links to
writable workspace files. With Seatbelt, each protected path must be a direct
entry of the workspace or lie inside one. With Bubblewrap, protected paths and
their ancestors must not be symbolic links.
*/
export async function planProtection(
	host: Host,
	request: ProtectionRequest
): Promise<Protection> {
	return request.workspaceAccess === 'read-only' ||
		request.resources.length === 0
		? { readonlyPaths: [], placeholders: [], pins: [] }
		: new ProtectionPlan(host, request).build();
}
