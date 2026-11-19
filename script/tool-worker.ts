import { access, readFile, unlink } from 'node:fs/promises';

import type {
	ExtensionToolContext,
	ToolDefinition
} from '@earendil-works/pi-coding-agent';
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition
} from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

const model = Type.Object({
	input: Type.Array(Type.String()),
	inputLimits: Type.Optional(Type.Unknown())
});
const envelope = Compile(
	Type.Object({
		name: Type.String(),
		input: Type.Unknown(),
		autoResizeImages: Type.Boolean(),
		model: Type.Optional(model)
	})
);

async function run<T extends TSchema, D>(
	tool: ToolDefinition<T, D>,
	input: unknown,
	context: ExtensionToolContext
) {
	const schema = Compile(tool.parameters);

	if (!schema.Check(input)) {
		throw new Error(`Invalid ${tool.name} arguments.`);
	}

	return tool.execute('mxc', input, undefined, undefined, context);
}

async function execute() {
	const [source, data] = process.argv.slice(2);

	if (data === undefined) {
		throw new Error('Missing Pi tool input.');
	}

	let json = data;

	if (source === 'file') {
		json = await readFile(data, 'utf8');
		await unlink(data);
	}

	const request: unknown = JSON.parse(json);

	if (!envelope.Check(request)) {
		throw new Error('Invalid Pi tool input.');
	}

	const cwd = process.cwd();
	const context = { cwd, model: request.model } as ExtensionToolContext;

	switch (request.name) {
		case 'read': {
			return run(
				createReadToolDefinition(cwd, {
					autoResizeImages: request.autoResizeImages
				}),
				request.input,
				context
			);
		}

		case 'write': {
			return run(createWriteToolDefinition(cwd), request.input, context);
		}

		case 'preview': {
			return run(
				createEditToolDefinition(cwd, {
					operations: {
						readFile,
						access: (filename) => access(filename, 4),
						writeFile: () => Promise.resolve()
					}
				}),
				request.input,
				context
			);
		}

		case 'edit': {
			return run(createEditToolDefinition(cwd), request.input, context);
		}

		case 'ls': {
			return run(createLsToolDefinition(cwd), request.input, context);
		}

		case 'find': {
			return run(createFindToolDefinition(cwd), request.input, context);
		}

		case 'grep': {
			return run(createGrepToolDefinition(cwd), request.input, context);
		}

		default: {
			throw new Error('Unknown Pi tool.');
		}
	}
}

try {
	process.stdout.write(JSON.stringify(await execute()));
} catch (error) {
	process.stderr.write(
		error instanceof Error ? error.message : 'Pi tool execution failed.'
	);
	process.exitCode = 1;
}
