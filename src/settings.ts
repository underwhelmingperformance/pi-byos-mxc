import path from 'node:path';

import type {
	SandboxPolicy,
	ShellDialect,
	WorkspaceProtection
} from 'pi-bring-your-own-sandbox/api';
import { HOST_CONFIGURATION_PROTECTION } from 'pi-bring-your-own-sandbox/api';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import type { MxcConfig } from './config.js';
import {
	absolutePath,
	environmentSchema,
	invalidPaths,
	shellsSchema,
	validateConfig
} from './config.js';
import { InvalidSettingsFileError, SettingsFileSyntaxError } from './errors.js';
import type { HostFileSystem } from './host.js';

/**
The settings file name in Pi's agent directory.
*/
export const SETTINGS_FILE = 'mxc-sandbox.json';

// A workspace-relative path with `/` separators and no empty, `.` or `..`
// components, as BYOS requires for protected resources.
const protectedPath = Type.String({
	pattern: String.raw`^(?!/)(?!.*//)(?!.*/$)(?!(?:.*/)?\.{1,2}(?:/|$))[^\\:\u0000]+$`
});
const schema = Type.Object(
	{
		mode: Type.Optional(Type.Enum(['standard', 'strict', 'read-only'])),
		network: Type.Optional(Type.Enum(['off', 'on', 'denied'])),
		backend: Type.Optional(Type.Enum(['auto', 'seatbelt', 'bubblewrap'])),
		readonlyPaths: Type.Optional(
			Type.Array(absolutePath, { uniqueItems: true })
		),
		protectPaths: Type.Optional(
			Type.Array(protectedPath, { uniqueItems: true })
		),
		shells: Type.Optional(shellsSchema),
		environment: Type.Optional(environmentSchema),
		userShell: Type.Optional(Type.Enum(['sh', 'bash']))
	},
	{ additionalProperties: false }
);
const validator = Compile(schema);

const MODES: Readonly<
	Record<
		'standard' | 'strict' | 'read-only',
		Pick<SandboxPolicy, 'workspaceAccess' | 'filesystemScope'>
	>
> = Object.freeze({
	standard: {
		workspaceAccess: 'read-write',
		filesystemScope: 'provider-default'
	},
	strict: {
		workspaceAccess: 'read-write',
		filesystemScope: 'system-read-only'
	},
	'read-only': {
		workspaceAccess: 'read-only',
		filesystemScope: 'provider-default'
	}
});

/**
The sandbox selection described by the settings file: the BYOS policy, the
provider configuration and the shell for Pi's user commands.
*/
export interface Settings {
	readonly policy: SandboxPolicy;
	readonly configuration: MxcConfig;
	readonly userShell?: ShellDialect;
}

async function readContents(
	fs: HostFileSystem,
	file: string
): Promise<string | undefined> {
	try {
		await fs.lstat(file);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return undefined;
		}

		throw error;
	}

	return fs.readFile(file, 'utf8');
}

function parse(file: string, contents: string): unknown {
	try {
		return JSON.parse(contents);
	} catch (error) {
		throw new SettingsFileSyntaxError(file, { cause: error });
	}
}

/**
Reads the settings file from `agentDirectory` and maps it to a sandbox
selection. A missing file selects the standard mode with the network off.
Rejects with `SettingsFileSyntaxError` or `InvalidSettingsFileError` when the
file cannot be used.
*/
export async function readSettings(
	fs: HostFileSystem,
	agentDirectory: string
): Promise<Settings> {
	const file = path.join(agentDirectory, SETTINGS_FILE);
	const contents = await readContents(fs, file);
	const input = contents === undefined ? {} : parse(file, contents);

	if (!validator.Check(input)) {
		throw new InvalidSettingsFileError(file, invalidPaths(validator, input));
	}

	const protection: WorkspaceProtection[] = [
		...HOST_CONFIGURATION_PROTECTION,
		...(input.protectPaths ?? []).map((entry) => ({
			kind: 'path' as const,
			path: entry
		}))
	];

	return {
		policy: {
			...MODES[input.mode ?? 'standard'],
			networkAccess: input.network === 'denied' ? 'denied' : 'provider-default',
			workspaceProtection: protection
		},
		configuration: validateConfig({
			network: input.network === 'on' ? 'open-egress' : 'ip-denied',
			...(input.backend !== undefined && { backend: input.backend }),
			...(input.readonlyPaths !== undefined && {
				readonlyPaths: input.readonlyPaths
			}),
			...(input.shells !== undefined && { shells: input.shells }),
			...(input.environment !== undefined && {
				environment: input.environment
			})
		}),
		...(input.userShell !== undefined && { userShell: input.userShell })
	};
}
