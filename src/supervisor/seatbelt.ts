import { isPathWithin } from '../paths.js';

import type { StartMessage } from './protocol.js';

function subtree(filename: string): string {
	if (/[\p{Cc}]/u.test(filename)) {
		throw new Error(
			'Seatbelt grants require paths without control characters.'
		);
	}

	return `(subpath ${JSON.stringify(filename)})`;
}

function deniedPath(
	operation: 'file-read*' | 'file-write*',
	filename: string,
	grants: readonly string[]
): readonly string[] {
	const exceptions = grants.filter((grant) => isPathWithin(filename, grant));

	if (exceptions.includes(filename)) {
		return [];
	}

	const root = subtree(filename);
	const filter =
		exceptions.length === 0
			? root
			: `(require-all ${root} ${exceptions.map((grant) => `(require-not ${subtree(grant)})`).join(' ')})`;

	return [`(deny ${operation} ${filter})`];
}

export function offlineProfile(request: StartMessage): string {
	const read = [
		...request.readonlyPaths,
		...request.readwritePaths,
		'/bin',
		'/sbin',
		'/usr/bin',
		'/usr/sbin',
		'/usr/lib',
		'/usr/libexec',
		'/usr/share',
		'/private/etc',
		'/System/Library',
		'/System/Volumes/Preboot/Cryptexes/OS/System/Library',
		'/Applications/Xcode.app/Contents/Developer/usr',
		'/Library/Developer/CommandLineTools'
	];

	return [
		'(version 1)',
		'(deny default)',
		'(allow process-fork process-exec sysctl-read)',
		'(allow signal (target same-sandbox))',
		'(allow file-read-metadata)',
		'(allow file-read* (literal "/") (literal "/private/var/select/sh") (literal "/dev/urandom") (literal "/dev/random"))',
		'(allow file-read* file-write-data (literal "/dev/null"))',
		`(allow file-read* file-map-executable ${read.map((filename) => subtree(filename)).join(' ')})`,
		...request.readwritePaths.map((p) => `(allow file-write* ${subtree(p)})`),
		...request.readonlyPaths
			.filter((p) =>
				request.readwritePaths.some((root) => isPathWithin(root, p))
			)
			.map((p) => `(deny file-write* ${subtree(p)})`),
		...request.deniedPaths.flatMap((filename) => [
			...deniedPath(
				'file-read*',
				filename,
				request.credentialGrants?.read ?? []
			),
			...deniedPath(
				'file-write*',
				filename,
				request.credentialGrants?.write ?? []
			)
		])
	].join('\n');
}
