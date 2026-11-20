import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { quote } from '../shell.js';

const execute = promisify(execFile);
const script =
	'open(my $lock, ">", "descendant.lock") or die $!; flock($lock, 2) or die $!; open(my $ready, ">", "descendant.ready") or die $!; close $ready or die $!; sleep 60;';

export function startDescendant(redirection: string): string {
	return `/usr/bin/perl -e ${quote(script)} ${redirection} & child=$!; while [ ! -f descendant.ready ]; do kill -0 "$child" || exit 1; sleep 0.02; done`;
}

export async function verifyDescendantStopped(
	workspace: string
): Promise<void> {
	// A PID from Bubblewrap's namespace can belong to a different process on the host.
	await execute('/usr/bin/perl', [
		'-e',
		'open(my $lock, "<", $ARGV[0]) or die $!; flock($lock, 2 | 4) or die $!;',
		path.join(workspace, 'descendant.lock')
	]);
}
