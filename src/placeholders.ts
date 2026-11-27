import { ProtectedSymbolicLinkError } from './errors.js';
import type { HostFileSystem } from './host.js';

interface Placeholder {
	readonly dev: number;
	readonly ino: number;
	readonly users: Set<symbol>;
}

type FileMetadata = Awaited<ReturnType<HostFileSystem['lstat']>>;

/**
Provider-owned placeholders leased by one command.
*/
export interface PlaceholderLease {
	readonly owned: readonly string[];

	/**
	Removes placeholders without another active lease. Call this only after the
	command's processes have stopped: unlinking a placeholder on the host
	detaches its mount inside a running sandbox.
	*/
	release(): Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

export class PlaceholderCleanupError extends AggregateError {
	override readonly name = 'PlaceholderCleanupError';
	readonly residues: readonly Error[];

	constructor(residues: readonly Error[]) {
		super(residues, 'MXC could not remove all unused placeholders.');
		this.residues = residues;
	}
}

/**
Creates the empty read-only files that cover absent protected paths while
Bubblewrap commands run. Commands share a placeholder, and the registry removes
it after the last lease releases it, provided it is still the empty file that
the registry created.
*/
export class PlaceholderRegistry {
	readonly #fs: HostFileSystem;
	readonly #placeholders = new Map<string, Placeholder>();
	readonly #pending = new Map<string, Promise<undefined>>();

	constructor(fs: HostFileSystem) {
		this.#fs = fs;
	}

	async #atPath<T>(filename: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#pending.get(filename);
		const next = Promise.withResolvers<undefined>();

		this.#pending.set(filename, next.promise);

		try {
			await previous;

			return await operation();
		} finally {
			next.resolve(undefined);

			if (this.#pending.get(filename) === next.promise) {
				this.#pending.delete(filename);
			}
		}
	}

	async #metadata(filename: string) {
		try {
			return await this.#fs.lstat(filename);
		} catch (error) {
			if (hasCode(error, 'ENOENT')) {
				return;
			}

			throw error;
		}
	}

	#isCurrent(
		metadata: FileMetadata | undefined,
		placeholder: Placeholder
	): boolean {
		return (
			metadata !== undefined &&
			metadata.isFile() &&
			metadata.size === 0 &&
			metadata.dev === placeholder.dev &&
			metadata.ino === placeholder.ino
		);
	}

	async #acquire(
		filename: string,
		user: symbol
	): Promise<Placeholder | undefined> {
		const existing = this.#placeholders.get(filename);

		if (
			existing !== undefined &&
			this.#isCurrent(await this.#metadata(filename), existing)
		) {
			existing.users.add(user);

			return existing;
		}

		this.#placeholders.delete(filename);

		try {
			await this.#fs.writeFile(filename, '', { flag: 'wx', mode: 0o644 });
		} catch (error) {
			if (!hasCode(error, 'EEXIST')) {
				throw error;
			}

			const metadata = await this.#fs.lstat(filename);

			if (metadata.isSymbolicLink()) {
				throw new ProtectedSymbolicLinkError(filename);
			}

			return;
		}

		const metadata = await this.#fs.lstat(filename);

		const placeholder = {
			dev: metadata.dev,
			ino: metadata.ino,
			users: new Set([user])
		};

		this.#placeholders.set(filename, placeholder);

		return placeholder;
	}

	async #release(filename: string, placeholder: Placeholder, user: symbol) {
		if (this.#placeholders.get(filename) !== placeholder) {
			return;
		}

		placeholder.users.delete(user);

		if (placeholder.users.size > 0) {
			return;
		}

		if (this.#isCurrent(await this.#metadata(filename), placeholder)) {
			await this.#fs.unlink(filename);
		}

		this.#placeholders.delete(filename);
	}

	inspect(filename: string): Promise<FileMetadata | undefined> {
		return this.#atPath(filename, async () => {
			const metadata = await this.#metadata(filename);
			const owned = this.#placeholders.get(filename);

			if (owned !== undefined && this.#isCurrent(metadata, owned)) {
				return;
			}

			return metadata;
		});
	}

	async acquire(filenames: readonly string[]): Promise<PlaceholderLease> {
		const user = Symbol();
		const leased = new Map<string, Placeholder>();
		const unique = new Set(filenames);

		const release = async () => {
			const results = await Promise.all(
				[...leased].map(async ([filename, placeholder]) => {
					try {
						await this.#atPath(filename, () =>
							this.#release(filename, placeholder, user)
						);
					} catch (error) {
						return new Error(`Could not remove MXC placeholder ${filename}.`, {
							cause: error
						});
					}

					leased.delete(filename);

					return;
				})
			);
			const failures = results.filter((result) => result !== undefined);

			if (failures.length > 0) {
				throw new PlaceholderCleanupError(failures);
			}
		};

		try {
			for (const filename of unique) {
				const placeholder = await this.#atPath(filename, () =>
					this.#acquire(filename, user)
				);

				if (placeholder !== undefined) {
					leased.set(filename, placeholder);
				}
			}
		} catch (error) {
			try {
				await release();
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					'MXC could not acquire or clean up its placeholder lease.',
					{ cause: cleanupError }
				);
			}

			throw error;
		}

		return { owned: leased.keys().toArray(), release };
	}
}
