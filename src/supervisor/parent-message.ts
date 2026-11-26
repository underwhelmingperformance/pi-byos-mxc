import type { ParentMessage } from './protocol.js';

// The supervisor starts once per command, and importing TypeBox there costs
// more than starting Node. `parent-message.test.ts` checks that this guard
// accepts exactly what the protocol schema accepts.

const ID = /^[a-f\d-]{36}$/u;
const ENVIRONMENT_KEY = /^[^=\0]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
	return typeof value === 'string' && !value.includes('\0');
}

function isAbsolutePath(value: unknown): value is string {
	return isText(value) && value.startsWith('/');
}

function isPathList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => isAbsolutePath(item));
}

function isEnvironment(value: unknown): value is Record<string, string> {
	return (
		isRecord(value) &&
		Object.entries(value).every(
			([key, text]) => ENVIRONMENT_KEY.test(key) && isText(text)
		)
	);
}

function isStart(message: Record<string, unknown>): boolean {
	return (
		(message.backend === 'seatbelt' || message.backend === 'bubblewrap') &&
		isText(message.network) &&
		['ip-denied', 'open-egress', 'denied'].includes(message.network) &&
		isText(message.command) &&
		isAbsolutePath(message.shell) &&
		isAbsolutePath(message.cwd) &&
		isPathList(message.readwritePaths) &&
		isEnvironment(message.environment) &&
		isPathList(message.readonlyPaths) &&
		isPathList(message.deniedPaths) &&
		(message.credentialGrants === undefined ||
			(isRecord(message.credentialGrants) &&
				isPathList(message.credentialGrants.read) &&
				isPathList(message.credentialGrants.write)))
	);
}

/**
Checks a message from the parent process without loading TypeBox.
*/
export function isParentMessage(value: unknown): value is ParentMessage {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== 'string' ||
		!ID.test(value.id)
	) {
		return false;
	}

	if (value.kind === 'start') {
		return isStart(value);
	}

	return value.kind === 'release' || value.kind === 'cancel';
}
