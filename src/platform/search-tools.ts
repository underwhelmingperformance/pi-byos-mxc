import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { compareText, isPathWithin } from '../paths.js';

import {
	inspectLinkedLibraries,
	linkedLibraryGrants
} from './linked-libraries.js';
import { isHostSystemPath } from './system-paths.js';

const installations = ['/opt', '/usr/local', '/nix/store', '/usr/bin'];

export interface SearchToolchain {
	readonly directories: string[];
	readonly files: string[];
}

export async function darwinSearchTools(
	workspace: string,
	hasHostReads: boolean
): Promise<SearchToolchain> {
	const piBin = path.join(getAgentDir(), 'bin');
	const directories = [
		piBin,
		...(process.env.PATH ?? '').split(path.delimiter)
	].filter(
		(entry) =>
			path.isAbsolute(entry) &&
			!isPathWithin(workspace, entry) &&
			(hasHostReads || entry !== piBin)
	);
	const tools = new Set<string>();
	const files = new Set<string>();

	const isAllowedInstallation = (filename: string) =>
		hasHostReads
			? installations.some((root) => isPathWithin(root, filename))
			: isHostSystemPath('darwin', filename);

	async function locate(name: string): Promise<void> {
		for (const directory of directories) {
			try {
				const candidate = path.join(directory, name);
				const file = await realpath(candidate);

				if (path.basename(file) !== name || isPathWithin(workspace, file)) {
					continue;
				}

				const isPersonalTool =
					hasHostReads && directory === piBin && file === candidate;

				if (!isPersonalTool && !isAllowedInstallation(file)) {
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

						if (!isAllowedInstallation(resolved)) {
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
