import path from 'node:path';

import type {
	registerSandboxProvider,
	SandboxSharedSettings
} from 'pi-bring-your-own-sandbox/provider';
import {
	cleanDisplayText,
	InvalidSandboxConfigError
} from 'pi-bring-your-own-sandbox/provider';
import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import { configSchema, invalidPaths } from './config.js';
import { InvalidSettingsFileError, SettingsFileSyntaxError } from './errors.js';
import type { HostFileSystem } from './host.js';

export const SETTINGS_FILE = 'mxc-sandbox.json';

type SharedSettingsSchema = Parameters<
	NonNullable<Parameters<typeof registerSandboxProvider>[3]>['configure']
>[1];

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

function configError(
	cause: Error,
	field = SETTINGS_FILE
): InvalidSandboxConfigError {
	return new InvalidSandboxConfigError(
		{
			operation: 'configure',
			configurationSource: 'extension',
			detail: { kind: 'config', field: cleanDisplayText(field) }
		},
		{ cause }
	);
}

function parse(file: string, contents: string): unknown {
	try {
		return JSON.parse(contents);
	} catch (error) {
		throw configError(new SettingsFileSyntaxError(file, { cause: error }));
	}
}

export async function readSettings(
	fs: HostFileSystem,
	agentDirectory: string,
	sharedSettingsSchema: SharedSettingsSchema
): Promise<{
	readonly configuration: Static<typeof configSchema>;
	readonly settings: SandboxSharedSettings;
}> {
	const file = path.join(agentDirectory, SETTINGS_FILE);
	const contents = await readContents(fs, file);
	const input = contents === undefined ? {} : parse(file, contents);
	const validator = Compile(
		Type.Object(
			{ ...sharedSettingsSchema.properties, ...configSchema.properties },
			{ additionalProperties: false }
		)
	);

	if (!validator.Check(input)) {
		const paths = invalidPaths(validator, input);

		throw configError(
			new InvalidSettingsFileError(file, paths),
			paths.join(', ') || SETTINGS_FILE
		);
	}

	const { backend, protectPaths, shells, environment, ...settings } = input;

	return {
		configuration: {
			...(backend !== undefined && { backend }),
			...(protectPaths !== undefined && { protectPaths }),
			...(shells !== undefined && { shells }),
			...(environment !== undefined && { environment })
		},
		settings
	};
}
