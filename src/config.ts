import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import { InvalidSettingsError } from './errors.js';

const absolutePath = Type.String({ pattern: '^/[^\\u0000]*$' });

const text = Type.String({ pattern: '^[^\\u0000]*$' });

const shellsSchema = Type.Object(
	{ sh: absolutePath, bash: Type.Optional(absolutePath) },
	{ additionalProperties: false }
);
const environmentSchema = Type.Record(
	Type.String({ pattern: '^[^=\\u0000]+$' }),
	text,
	{ additionalProperties: false }
);

const protectedPath = Type.String({
	pattern: String.raw`^(?!/)(?!.*//)(?!.*/$)(?!(?:.*/)?\.{1,2}(?:/|$))[^\\:\u0000]+$`
});

export const configSchema = Type.Object(
	{
		backend: Type.Optional(Type.Enum(['auto', 'seatbelt', 'bubblewrap'])),
		protectPaths: Type.Optional(
			Type.Array(protectedPath, { uniqueItems: true })
		),
		shells: Type.Optional(shellsSchema),
		environment: Type.Optional(environmentSchema)
	},
	{ additionalProperties: false }
);

const validator = Compile(configSchema);

export type MxcSettings = Static<typeof configSchema>;

export interface MxcConfig {
	readonly backend: NonNullable<MxcSettings['backend']>;
	readonly protectPaths: readonly string[];
	readonly shells: Readonly<{ sh: string; bash: string }>;
	readonly environment: Readonly<NonNullable<MxcSettings['environment']>>;
}

/**
Returns JSON pointers to the most specific invalid values in `input`. TypeBox
also reports each object that contains an invalid property, so containing
paths are omitted.
*/
export function invalidPaths(
	schemaValidator: {
		Errors(value: unknown): readonly { readonly instancePath: string }[];
	},
	input: unknown
): string[] {
	const paths = new Set(
		schemaValidator.Errors(input).map((error) => error.instancePath)
	);

	return [...paths].filter((candidate) =>
		[...paths].every((other) => !other.startsWith(`${candidate}/`))
	);
}

export function validateConfig(input: unknown): MxcConfig {
	if (!validator.Check(input)) {
		throw new InvalidSettingsError(invalidPaths(validator, input));
	}

	return Object.freeze({
		backend: input.backend ?? 'auto',
		protectPaths: Object.freeze([...(input.protectPaths ?? [])]),
		shells: Object.freeze({
			sh: input.shells?.sh ?? '/bin/sh',
			bash: input.shells?.bash ?? '/bin/bash'
		}),
		environment: Object.freeze({ ...input.environment })
	});
}
