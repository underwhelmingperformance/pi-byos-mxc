import { isPathWithin } from '../paths.js';

import type { StartMessage } from './protocol.js';

const DARWIN_DATA_VOLUME = '/System/Volumes/Data';

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
	const hasHostReads = request.hostUserData !== 'denied';
	const grantedReads = [...request.readonlyPaths, ...request.readwritePaths];
	const read = [...grantedReads, ...request.systemRoots].map((filename) =>
		subtree(filename)
	);

	return [
		'(version 1)',
		'(deny default)',
		'(allow process-fork process-exec sysctl-read)',
		'(allow signal (target same-sandbox))',
		'(allow file-read-metadata)',
		'(allow file-read* (literal "/") (literal "/private/var/select/sh") (literal "/dev/urandom") (literal "/dev/random"))',
		'(allow file-read* file-write-data (literal "/dev/null"))',
		'(allow file-write* (regex #"^/dev/fd/[0-9]+$"))',
		`(allow file-read* file-map-executable ${read.join(' ')})`,
		...request.readwritePaths.map((p) => `(allow file-write* ${subtree(p)})`),
		...request.readonlyPaths
			.filter((p) =>
				request.readwritePaths.some((root) => isPathWithin(root, p))
			)
			.map((p) => `(deny file-write* ${subtree(p)})`),
		...(hasHostReads
			? []
			: [
					...deniedPath('file-read*', DARWIN_DATA_VOLUME, grantedReads),
					...deniedPath(
						'file-write*',
						DARWIN_DATA_VOLUME,
						request.readwritePaths
					)
				]),
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
