import path from 'node:path';

import { OverlappingPathsError } from './errors.js';

/**
Compares two strings by UTF-16 code unit, independently of the host locale.
*/
export function compareText(left: string, right: string): number {
	return Number(left > right) - Number(left < right);
}

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
			throw new OverlappingPathsError(writable, protectedPath);
		}
	}
}
