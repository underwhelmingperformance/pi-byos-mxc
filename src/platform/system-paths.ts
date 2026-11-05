import { realpath, stat } from 'node:fs/promises';

import { MxcConfigError } from '../config.js';

interface SystemPathsIO {
	canonicalize(filename: string): Promise<string>;
	isRegularFile(filename: string): Promise<boolean>;
}

const filesystem: SystemPathsIO = {
	canonicalize: realpath,
	async isRegularFile(filename) {
		const metadata = await stat(filename);

		return metadata.isFile();
	}
};

export async function systemReadonlyPaths(
	platform: NodeJS.Platform,
	io: SystemPathsIO = filesystem
): Promise<string[]> {
	if (platform !== 'linux') {
		return [];
	}

	try {
		const resolver = await io.canonicalize('/etc/resolv.conf');

		if (!(await io.isRegularFile(resolver))) {
			throw new MxcConfigError(
				'The system DNS resolver must be a regular file.'
			);
		}

		return [resolver];
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return [];
		}

		throw error;
	}
}
