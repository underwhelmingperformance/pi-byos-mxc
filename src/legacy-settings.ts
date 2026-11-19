import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
	HOST_CONFIGURATION_PROTECTION,
	InvalidSandboxConfigError
} from 'pi-bring-your-own-sandbox/api';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import { validateConfig } from './config.js';

const strict = { additionalProperties: false } as const;
const paths = Type.Array(Type.String());
const resource = Type.Union([
	Type.Object({ kind: Type.Literal('git-metadata') }, strict),
	Type.Object({ kind: Type.Literal('path'), path: Type.String() }, strict)
]);
const preset = Type.Object(
	{
		preset: Type.Literal('host-configuration'),
		additionalPaths: Type.Optional(paths)
	},
	strict
);
const protection = Type.Union([Type.Array(resource), preset]);
const policy = Type.Object(
	{
		workspaceAccess: Type.Enum(['read-only', 'read-write']),
		filesystemScope: Type.Enum([
			'workspace-only',
			'system-read-only',
			'provider-default'
		]),
		networkAccess: Type.Enum(['denied', 'provider-default']),
		workspaceProtection: Type.Optional(protection)
	},
	strict
);
const cleanup = Type.Object(
	{
		cancellationGraceMs: Type.Optional(Type.Integer()),
		disposalTimeoutMs: Type.Optional(Type.Integer())
	},
	strict
);
const approval = Type.Object(
	{ policy: Type.String(), config: Type.Optional(Type.Unknown()) },
	strict
);
const outside = Type.Object(
	{ destination: Type.Enum(['normal', 'provider']) },
	strict
);
const config = Type.Object(
	{
		provider: Type.Optional(Type.Literal('mxc')),
		providerConfig: Type.Optional(Type.Unknown()),
		cleanup: Type.Optional(cleanup),
		policy: Type.Optional(policy),
		userShell: Type.Optional(Type.Enum(['sh', 'bash', 'powershell'])),
		approval: Type.Optional(approval),
		outsideSandbox: Type.Optional(outside)
	},
	strict
);
const schema = Compile(config);

export function legacySettings(directory: string) {
	let input: unknown;

	try {
		const file = path.join(directory, 'byos.json');

		if (!lstatSync(file, { throwIfNoEntry: false })) {
			return;
		}

		input = JSON.parse(readFileSync(file, 'utf8'));
	} catch (error) {
		throw new InvalidSandboxConfigError(
			{
				operation: 'configure',
				providerId: 'mxc',
				configurationSource: 'extension'
			},
			{ cause: error }
		);
	}

	if (!schema.Check(input)) {
		throw new InvalidSandboxConfigError({
			operation: 'configure',
			providerId: 'mxc',
			configurationSource: 'extension'
		});
	}

	const { policy, providerConfig, provider: _provider, ...other } = input;
	const protection = policy?.workspaceProtection;
	const resources =
		protection && 'preset' in protection
			? [
					...HOST_CONFIGURATION_PROTECTION,
					...(protection.additionalPaths ?? []).map((entry) => ({
						kind: 'path' as const,
						path: entry
					}))
				]
			: protection;

	return {
		...other,
		configuration: validateConfig(providerConfig ?? {}),
		...(policy && {
			policy: {
				workspaceAccess: policy.workspaceAccess,
				filesystemScope: policy.filesystemScope,
				networkAccess: policy.networkAccess,
				...(resources && { workspaceProtection: resources })
			}
		})
	};
}
