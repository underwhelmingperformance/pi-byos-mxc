import { UnsupportedGrantError } from './errors.js';
import { isPathWithin } from './paths.js';

/**
Canonical directories that contain operating-system files and installed
runtimes. The `system-read-only` scope accepts configured grants only inside
them.
*/
export const SYSTEM_ROOTS: Readonly<
	Partial<Record<NodeJS.Platform, readonly string[]>>
> = Object.freeze({
	darwin: Object.freeze([
		'/bin',
		'/sbin',
		'/usr',
		'/System',
		'/Library',
		'/Applications',
		'/opt',
		'/private/etc',
		'/nix/store'
	]),
	linux: Object.freeze([
		'/bin',
		'/sbin',
		'/usr',
		'/lib',
		'/lib32',
		'/lib64',
		'/libx32',
		'/etc',
		'/opt',
		'/nix/store',
		'/run/current-system'
	])
});

/**
Throws `UnsupportedGrantError` for the first canonical grant outside the
platform's system and runtime directories.
*/
export function assertSystemGrants(
	platform: NodeJS.Platform,
	grants: readonly string[]
): void {
	const roots = SYSTEM_ROOTS[platform] ?? [];

	for (const grant of grants) {
		if (roots.every((root) => !isPathWithin(root, grant))) {
			throw new UnsupportedGrantError(grant, roots);
		}
	}
}
