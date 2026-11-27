import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { compareText, isPathWithin } from '../paths.js';

import {
	inspectLinkedLibraries,
	linkedLibraryGrants
} from './linked-libraries.js';

const installations = ['/opt', '/usr/local', '/nix/store', '/usr/bin'];

export interface SearchToolchain {
	readonly directories: string[];
	readonly files: string[];
}

export async function darwinSearchTools(
	workspace: string,
	restrictedHome?: string
): Promise<SearchToolchain> {
	const piBin = path.join(getAgentDir(), 'bin');
	const directories = [
		piBin,
		...(process.env.PATH ?? '').split(path.delimiter)
	].filter(
		(entry) =>
			path.isAbsolute(entry) &&
			!isPathWithin(workspace, entry) &&
			(restrictedHome === undefined || entry !== piBin)
	);
	const tools = new Set<string>();
	const files = new Set<string>();

	async function locate(name: string): Promise<void> {
		for (const directory of directories) {
			try {
				const candidate = path.join(directory, name);
				const file = await realpath(candidate);

				if (path.basename(file) !== name || isPathWithin(workspace, file)) {
					continue;
				}

				if (
					restrictedHome !== undefined &&
					isPathWithin(restrictedHome, file)
				) {
					continue;
				}

				if (
					!(directory === piBin && file === candidate) &&
					installations.every((root) => !isPathWithin(root, file))
				) {
					continue;
				}

				const metadata = await stat(file);

				if (!metadata.isFile()) {
					continue;
				}

				await access(file, constants.X_OK);

				const grants = await linkedLibraryGrants(file, {
					platform: 'darwin',
					workspace,
					inspect: inspectLinkedLibraries,
					async realpath(candidate) {
						const resolved = await realpath(candidate);

						if (
							(restrictedHome !== undefined &&
								isPathWithin(restrictedHome, resolved)) ||
							installations.every((root) => !isPathWithin(root, resolved))
						) {
							throw new Error(
								'The tool has a library outside its system installation.'
							);
						}

						return resolved;
					}
				});

				files.add(file);

				for (const grant of grants) {
					files.add(grant);
				}

				tools.add(path.dirname(file));

				return;
			} catch {
				continue;
			}
		}
	}

	await Promise.all([locate('fd'), locate('rg')]);

	return {
		directories: [...tools].toSorted(compareText),
		files: [...files].toSorted(compareText)
	};
}
