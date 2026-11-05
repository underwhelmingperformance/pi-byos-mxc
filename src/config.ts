import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

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
const schema = Type.Object(
	{
		backend: Type.Optional(Type.Enum(['auto', 'seatbelt', 'bubblewrap'])),
		network: Type.Optional(Type.Enum(['ip-denied', 'open-egress'])),
		shells: Type.Optional(shellsSchema),
		readonlyPaths: Type.Optional(
			Type.Array(absolutePath, { uniqueItems: true })
		),
		environment: Type.Optional(environmentSchema)
	},
	{ additionalProperties: false }
);
const validator = Compile(schema);

export interface MxcConfig {
	readonly backend: 'auto' | 'seatbelt' | 'bubblewrap';
	readonly network: 'ip-denied' | 'open-egress';
	readonly shells: Readonly<{ sh: string; bash?: string }>;
	readonly readonlyPaths: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
}

export class MxcConfigError extends Error {
	override readonly name = 'MxcConfigError';
}

export function validateConfig(input: unknown): MxcConfig {
	if (!validator.Check(input)) {
		throw new MxcConfigError(
			'Invalid MXC settings. Use supported backend/network modes, absolute paths and string environment values.'
		);
	}

	return Object.freeze({
		backend: input.backend ?? 'auto',
		network: input.network ?? 'ip-denied',
		shells: Object.freeze({
			...(input.shells ?? { sh: '/bin/sh', bash: '/bin/bash' })
		}),
		readonlyPaths: Object.freeze([...(input.readonlyPaths ?? [])]),
		environment: Object.freeze({ ...input.environment })
	});
}
