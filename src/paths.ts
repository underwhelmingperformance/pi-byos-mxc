import path from 'node:path';

import { MxcConfigError } from './config.js';

export function isPathWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);

	return (
		relative === '' ||
		(relative !== '..' &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

export function assertDisjointPaths(
	writable: string,
	protectedPaths: readonly string[]
): void {
	for (const protectedPath of protectedPaths) {
		if (
			isPathWithin(writable, protectedPath) ||
			isPathWithin(protectedPath, writable)
		) {
			throw new MxcConfigError(
				'Writable workspace/scratch paths must be separate from trusted runtime files, recovery metadata and read-only grants.'
			);
		}
	}
}
