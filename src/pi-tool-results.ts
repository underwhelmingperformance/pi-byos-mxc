import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

const integer = Type.Integer();
const truncation = Type.Object({
	content: Type.String(),
	truncated: Type.Boolean(),
	truncatedBy: Type.Union([Type.Enum(['lines', 'bytes']), Type.Null()]),
	totalLines: integer,
	totalBytes: integer,
	outputLines: integer,
	outputBytes: integer,
	lastLinePartial: Type.Boolean(),
	firstLineExceedsLimit: Type.Boolean(),
	maxLines: integer,
	maxBytes: integer
});
const details = Type.Object({
	truncation: Type.Optional(truncation),
	entryLimitReached: Type.Optional(integer),
	matchLimitReached: Type.Optional(integer),
	resultLimitReached: Type.Optional(integer),
	linesTruncated: Type.Optional(Type.Boolean())
});
const editDetails = Type.Object({
	diff: Type.String(),
	patch: Type.String(),
	firstChangedLine: Type.Optional(integer)
});
const image = Type.Object({
	type: Type.Literal('image'),
	mimeType: Type.String(),
	data: Type.String()
});
const text = Type.Object({ type: Type.Literal('text'), text: Type.String() });
const imageNote = Type.Object({ ...image.properties, note: Type.String() });
const fields = {
	content: Type.Array(Type.Union([image, text])),
	structuredContent: Type.Optional(Type.Union([Type.String(), imageNote]))
};
const ordinary = Compile(
	Type.Object({ ...fields, details: Type.Optional(details) })
);
const edit = Compile(Type.Object({ ...fields, details: editDetails }));

export function toolResult(data: unknown) {
	if (!ordinary.Check(data)) {
		throw new Error('The sandbox returned an invalid Pi tool result.');
	}

	return { ...data, details: data.details };
}

export function editResult(data: unknown) {
	if (!edit.Check(data)) {
		throw new Error('The sandbox returned an invalid edit result.');
	}

	return data;
}
