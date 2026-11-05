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

type MxcSettings = Static<typeof schema>;

export type MxcConfig = {
	readonly [Key in keyof MxcSettings]-?: Readonly<
		Exclude<MxcSettings[Key], undefined>
	>;
};

export function validateConfig(input: unknown): MxcConfig {
	if (!validator.Check(input)) {
		const paths = new Set(
			validator.Errors(input).map((error) => error.instancePath)
		);

		throw new InvalidSettingsError(
			[...paths].filter((candidate) =>
				[...paths].every((other) => !other.startsWith(`${candidate}/`))
			)
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
