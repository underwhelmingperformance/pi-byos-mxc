import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { compareText, isPathWithin } from '../paths.js';

const execute = promisify(execFile);
const installations = ['/opt', '/usr/local', '/nix/store', '/usr/bin'];

export interface SearchToolchain {
	readonly directories: string[];
	readonly files: string[];
}

async function libraries(
	binary: string,
	workspace: string,
	inspector: string
): Promise<string[]> {
	const files = new Set([binary]);

	const pending = [binary];

	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		const { stdout } = await execute(inspector, ['-L', file], {
			cwd: '/',
			env: { PATH: '/usr/bin:/bin' },
			timeout: 3000
		});

		for (const line of stdout.split('\n').slice(1)) {
			const library = line.trim().split(' (', 1)[0];

			if (
				!library ||
				library.startsWith('/usr/lib/') ||
				library.startsWith('/System/Library/')
			) {
				continue;
			}

			const candidate = library.startsWith('@loader_path/')
				? path.join(path.dirname(file), library.slice('@loader_path/'.length))
				: library;

			if (!path.isAbsolute(candidate)) {
				throw new Error(
					'The tool uses a library search path that requires explicit grants.'
				);
			}

			const resolved = await realpath(candidate);

			if (
				isPathWithin(workspace, resolved) ||
				installations.every((root) => !isPathWithin(root, resolved))
			) {
				throw new Error(
					'The tool has a library outside its system installation.'
				);
			}

			if (files.has(resolved)) {
				continue;
			}

			files.add(resolved);
			pending.push(resolved);
		}
	}

	return [...files];
}

async function libraryInspector(): Promise<string> {
	try {
		return await realpath('/Library/Developer/CommandLineTools/usr/bin/otool');
	} catch {
		return '/usr/bin/otool';
	}
}

export async function darwinSearchTools(
	workspace: string
): Promise<SearchToolchain> {
	const inspector = await libraryInspector();
	const piBin = path.join(getAgentDir(), 'bin');
	const directories = [
		piBin,
		...(process.env.PATH ?? '').split(path.delimiter)
	].filter(
		(entry) => path.isAbsolute(entry) && !isPathWithin(workspace, entry)
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

				const grants = await libraries(file, workspace, inspector);

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
