import type {
	BackendProcessContext,
	BackendProcessOutcome,
	BackendSearch,
	FindRequest,
	GrepRequest,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/provider';
import {
	SandboxCancelledError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError
} from 'pi-bring-your-own-sandbox/provider';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import { quote } from './shell.js';

const strings = Type.Array(Type.String());
const findResult = Compile(
	Type.Object({ paths: strings, truncated: Type.Boolean() })
);
const match = Type.Object({
	path: Type.String(),
	line: Type.Integer({ minimum: 1 }),
	text: Type.String(),
	before: strings,
	after: strings
});
const grepResult = Compile(
	Type.Object({ matches: Type.Array(match), truncated: Type.Boolean() })
);

export function sandboxSearch(
	node: string,
	worker: string,
	run: (
		command: string,
		context: BackendProcessContext
	) => Promise<BackendProcessOutcome>
): BackendSearch {
	async function search(
		operation: 'find' | 'grep',
		request: FindRequest | GrepRequest,
		context: SandboxOperationContext
	): Promise<unknown> {
		const parameters = new URLSearchParams();

		for (const [key, value] of Object.entries(request)) {
			parameters.set(key, String(value));
		}

		const command = [
			'exec',
			quote(node),
			quote(worker),
			operation,
			quote(parameters.toString())
		].join(' ');
		const output: Buffer[] = [];
		const identity = { providerId: 'mxc', operation };
		let size = 0;
		const result = await run(command, {
			...context,
			onOutput(chunk) {
				if (chunk.stream !== 'stdout') {
					return;
				}

				size += chunk.data.byteLength;

				if (size > 16 * 1024 * 1024) {
					throw new SandboxOperationError(identity);
				}

				output.push(Buffer.from(chunk.data));
			}
		});

		if (result.kind === 'cancelled') {
			throw new SandboxCancelledError({
				...identity,
				reason: 'caller',
				completion:
					result.termination === 'unconfirmed' ? 'unknown' : result.termination
			});
		}

		if (result.exit.kind === 'code') {
			switch (result.exit.code) {
				case 0: {
					return JSON.parse(Buffer.concat(output).toString());
				}

				case 43: {
					throw new SandboxPermissionDeniedError(identity);
				}

				case 44: {
					throw new SandboxPathNotFoundError(identity);
				}
			}
		}

		throw new SandboxOperationError(identity);
	}

	return {
		async find(request, context) {
			const result = await search('find', request, context);

			if (!findResult.Check(result)) {
				throw new SandboxOperationError({
					providerId: 'mxc',
					operation: 'find'
				});
			}

			return result;
		},
		async grep(request, context) {
			const result = await search('grep', request, context);

			if (!grepResult.Check(result)) {
				throw new SandboxOperationError({
					providerId: 'mxc',
					operation: 'grep'
				});
			}

			return result;
		}
	};
}
