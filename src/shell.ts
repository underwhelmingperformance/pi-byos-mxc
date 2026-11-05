import type { ProcessEnvironment } from 'pi-bring-your-own-sandbox/api';

interface ShellTransport {
	readonly gate: string;
	readonly shell: string;
	readonly command: string;
	readonly environment: Readonly<Record<string, string>>;
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function targetEnvironment(
	defaults: Readonly<Record<string, string>>,
	overrides?: ProcessEnvironment
): Record<string, string> {
	const environment = new Map(Object.entries(defaults));
	const entries = Object.entries(overrides ?? {});

	for (const [key, value] of entries) {
		if (value === null) {
			environment.delete(key);

			continue;
		}

		environment.set(key, value);
	}

	return Object.fromEntries(environment);
}

export function transportCommand(invocation: ShellTransport): string {
	const environment = Object.entries(invocation.environment).map(
		([key, value]) => quote(`${key}=${value}`)
	);
	const target = [
		'/usr/bin/env',
		'-i',
		...environment,
		quote(invocation.shell),
		'-c',
		quote(invocation.command)
	].join(' ');

	return `IFS= read -r token || exit 125; [ "$token" = ${quote(invocation.gate)} ] || exit 125; exec ${target}`;
}
