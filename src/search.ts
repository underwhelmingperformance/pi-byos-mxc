import path from 'node:path';

import {
	GrepOutput,
	sandboxRipgrepArguments
} from 'pi-bring-your-own-sandbox/consumer';
import type {
	BackendFiles,
	BackendProcessContext,
	BackendProcessOutcome,
	BackendSearch,
	FindRequest,
	GrepRequest,
	SandboxBackend,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/provider';
import {
	isSandboxError,
	mapSandboxErrno,
	SandboxCancelledError,
	SandboxOperationError,
	SandboxPathNotFoundError
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

export function sandboxSearch(options: {
	readonly node: string;
	readonly worker: string;
	readonly workspace: string;
	readonly stat: Required<BackendFiles>['read']['stat'];
	readonly exec: SandboxBackend['exec'];
	readonly run: (
		command: string,
		context: BackendProcessContext
	) => Promise<BackendProcessOutcome>;
}): BackendSearch {
	const { node, worker, workspace, stat, exec, run } = options;

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
					throw mapSandboxErrno('EACCES', identity);
				}

				case 44: {
					throw mapSandboxErrno('ENOENT', identity);
				}
			}
		}

		throw new SandboxOperationError(identity);
	}

	async function ripgrep(
		request: GrepRequest,
		context: SandboxOperationContext
	) {
		const target = path.resolve(workspace, request.path ?? '.');
		const { kind } = await stat(target, context);
		const identity = { providerId: 'mxc', operation: 'grep' } as const;

		if (kind !== 'directory' && kind !== 'file') {
			throw new SandboxOperationError(identity);
		}

		const isDirectory = kind === 'directory';
		const lines = request.context ?? 0;
		const parser = new GrepOutput(lines, request.limit ?? 100);
		let parseError: unknown;
		let outcome: BackendProcessOutcome;

		try {
			outcome = await exec(
				{
					kind: 'argv',
					executable: 'rg',
					cwd: isDirectory ? target : path.dirname(target),
					args: sandboxRipgrepArguments(
						request,
						isDirectory ? '.' : path.basename(target),
						['--context', String(lines)]
					)
				},
				{
					...context,
					onOutput({ stream, data }) {
						if (stream !== 'stdout' || parseError !== undefined) {
							return;
						}

						try {
							parser.write(data);
						} catch (error) {
							parseError = error;
						}
					}
				}
			);
		} catch (error) {
			if (isSandboxError(error, SandboxPathNotFoundError)) {
				return;
			}

			throw error;
		}

		if (outcome.kind === 'cancelled') {
			throw new SandboxCancelledError({
				...identity,
				reason: 'caller',
				completion:
					outcome.termination === 'unconfirmed'
						? 'unknown'
						: outcome.termination
			});
		}

		if (
			parseError !== undefined ||
			outcome.exit.kind !== 'code' ||
			![0, 1].includes(outcome.exit.code)
		) {
			throw new SandboxOperationError(identity, { cause: parseError });
		}

		return parser.finish();
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
			const result =
				(await ripgrep(request, context)) ??
				(await search('grep', request, context));

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
