import { ProtectedSymbolicLinkError } from './errors.js';
import type { HostFileSystem } from './host.js';

interface Placeholder {
	readonly dev: number;
	readonly ino: number;
	users: number;
}

/**
Placeholders granted to one command. `paths` lists everything to grant
read-only, and `created` lists the placeholders that this lease holds.
*/
export interface PlaceholderLease {
	readonly paths: readonly string[];
	readonly created: readonly string[];

	/**
	Removes placeholders that no other lease holds. Call this only after the
	command's processes have stopped: unlinking a placeholder on the host
	detaches its mount inside a running sandbox.
	*/
	release(): Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
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

	constructor(fs: HostFileSystem) {
		this.#fs = fs;
	}

	async #isCurrent(filename: string, placeholder: Placeholder) {
		try {
			const metadata = await this.#fs.lstat(filename);

			return (
				metadata.isFile() &&
				metadata.size === 0 &&
				metadata.dev === placeholder.dev &&
				metadata.ino === placeholder.ino
			);
		} catch (error) {
			if (hasCode(error, 'ENOENT')) {
				return false;
			}

			throw error;
		}
	}

	// Returns whether this call holds the placeholder. A path that the host
	// created after planning is granted as it is and never removed.
	async #hold(filename: string): Promise<boolean> {
		const existing = this.#placeholders.get(filename);

		if (existing !== undefined && (await this.#isCurrent(filename, existing))) {
			existing.users++;

			return true;
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

			return false;
		}

		const metadata = await this.#fs.lstat(filename);

		this.#placeholders.set(filename, {
			dev: metadata.dev,
			ino: metadata.ino,
			users: 1
		});

		return true;
	}

	async #release(filename: string): Promise<void> {
		const placeholder = this.#placeholders.get(filename);

		if (placeholder === undefined) {
			return;
		}

		placeholder.users--;

		if (placeholder.users > 0) {
			return;
		}

		this.#placeholders.delete(filename);

		if (await this.#isCurrent(filename, placeholder)) {
			await this.#fs.unlink(filename);
		}
	}

	async acquire(filenames: readonly string[]): Promise<PlaceholderLease> {
		const held: string[] = [];
		const created: string[] = [];
		const release = async () => {
			const pending = held.splice(0);

			for (const filename of pending) {
				await this.#release(filename);
			}
		};

		try {
			for (const filename of filenames) {
				const placeholder = this.#placeholders.get(filename);
				const isHeld = await this.#hold(filename);

				if (!isHeld) {
					continue;
				}

				held.push(filename);

				if (placeholder === undefined) {
					created.push(filename);
				}
			}
		} catch (error) {
			await release();

			throw error;
		}

		return { paths: [...filenames], created, release };
	}
}
