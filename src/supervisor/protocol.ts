import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

const id = Type.String({ pattern: '^[a-f0-9-]{36}$' });
const text = Type.String({ pattern: '^[^\\u0000]*$' });
const absolutePath = Type.String({ pattern: '^/[^\\u0000]*$' });
const environment = Type.Record(
	Type.String({ pattern: '^[^=\\u0000]+$' }),
	text,
	{ additionalProperties: false }
);
const version = Type.Literal(1);

export const MAX_START_BYTES = 1_048_576;

const startSchema = Type.Object({
	version,
	kind: Type.Literal('start'),
	id,
	backend: Type.Enum(['seatbelt', 'bubblewrap']),
	network: Type.Enum(['ip-denied', 'open-egress']),
	command: text,
	shell: absolutePath,
	cwd: absolutePath,
	readwritePaths: Type.Array(absolutePath),
	environment,
	readonlyPaths: Type.Array(absolutePath),
	deniedPaths: Type.Array(absolutePath)
});

const parentSchema = Type.Union([
	startSchema,
	Type.Object({ version, kind: Type.Literal('release'), id }),
	Type.Object({ version, kind: Type.Literal('cancel'), id })
]);
const childSchema = Type.Union([
	Type.Object({ version, kind: Type.Literal('ready') }),
	Type.Object({
		version,
		kind: Type.Literal('started'),
		id,
		pid: Type.Integer({ minimum: 1 })
	}),
	Type.Object({
		version,
		kind: Type.Literal('completed'),
		id,
		exitCode: Type.Integer(),
		warnings: Type.Integer({ minimum: 0, maximum: 64 })
	}),
	Type.Object({ version, kind: Type.Literal('failed'), id })
]);

export type StartMessage = Static<typeof startSchema>;
export type ParentMessage = Static<typeof parentSchema>;
export type ChildMessage = Static<typeof childSchema>;

export const parentMessage = Compile(parentSchema);
export const childMessage = Compile(childSchema);
