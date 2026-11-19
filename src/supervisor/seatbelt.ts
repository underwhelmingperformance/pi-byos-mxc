import type { StartMessage } from './protocol.js';

function subtree(filename: string): string {
	if (/[\p{Cc}]/u.test(filename)) {
		throw new Error(
			'Seatbelt grants require paths without control characters.'
		);
	}

	return `(subpath ${JSON.stringify(filename)})`;
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
		'/System/Library',
		'/System/Volumes/Preboot/Cryptexes/OS/System/Library',
		'/Applications/Xcode.app/Contents/Developer/usr',
		'/Library/Developer/CommandLineTools'
	];

	return [
		'(version 1)',
		'(deny default)',
		'(allow process-fork process-exec sysctl-read)',
		'(allow file-read-metadata)',
		'(allow file-read* (literal "/") (literal "/private/var/select/sh") (literal "/dev/urandom") (literal "/dev/random"))',
		'(allow file-read* file-write-data (literal "/dev/null"))',
		`(allow file-read* file-map-executable ${read.map((filename) => subtree(filename)).join(' ')})`,
		...request.readwritePaths.map((p) => `(allow file-write* ${subtree(p)})`),
		...request.readonlyPaths.map((p) => `(deny file-write* ${subtree(p)})`),
		...request.deniedPaths.map(
			(p) => `(deny file-read* file-write* ${subtree(p)})`
		)
	].join('\n');
}
