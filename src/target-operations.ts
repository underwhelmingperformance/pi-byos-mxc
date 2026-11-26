import path from 'node:path';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	SandboxErrorContext,
	TargetFileOperations
} from 'pi-bring-your-own-sandbox/provider';
import {
	checkSandboxTargetStatus,
	createTargetFileOperations,
	encodePosixArgv,
	SandboxCancelledError,
	SandboxOperationError,
	sandboxTargetTransferLimit,
	SandboxTransportError,
	targetFileHelper,
	targetSearchHelper
} from 'pi-bring-your-own-sandbox/provider';

type RunTargetCommand<Input> = (
	command: string,
	context: BackendProcessContext,
	input: Input
) => Promise<BackendProcessOutcome>;

const searchProgram: { input?: Promise<Uint8Array> } = {};

async function loadSearchInput(): Promise<Uint8Array> {
	const source = await targetSearchHelper({
		sameConfinementAsCommands: true
	});

	// Node adds '-' to argv for stdin. The SDK helper expects eval's argument layout.
	return Buffer.from(`process.argv.splice(1, 1);\n${source}`);
}

function searchInput(): Promise<Uint8Array> {
	searchProgram.input ??= loadSearchInput();

	return searchProgram.input;
}

export function sandboxTargetOperations(
	workspace: string,
	node: string,
	run: {
		readonly file: RunTargetCommand<Uint8Array | undefined>;
		readonly search: RunTargetCommand<Uint8Array>;
	},
	identity: Omit<SandboxErrorContext, 'operation'>
): TargetFileOperations {
	let fileProgram: Promise<string> | undefined;

	return createTargetFileOperations(
		async (operation, filename, context, input, requiresWrite) => {
			const isSearch = operation === 'find' || operation === 'grep';
			const program = isSearch
				? ['-']
				: ['--eval', await (fileProgram ??= targetFileHelper()), '--'];
			const fileMode = requiresWrite ? 'write' : String(input?.byteLength ?? 0);

			const command =
				'exec ' +
				encodePosixArgv([
					node,
					'--input-type=module',
					...program,
					operation,
					isSearch ? filename : path.resolve(workspace, filename),
					String(sandboxTargetTransferLimit),
					isSearch ? workspace : fileMode
				]);
			const details = { ...identity, operation };
			const output: Uint8Array[] = [];
			let size = 0;
			const processContext: BackendProcessContext = {
				...context,
				onOutput({ stream, data }) {
					if (stream !== 'stdout') {
						return;
					}

					size += data.byteLength;

					if (size <= sandboxTargetTransferLimit) {
						output.push(data);
					}
				}
			};
			const result = isSearch
				? await run.search(command, processContext, await searchInput())
				: await run.file(command, processContext, input);

			if (result.kind === 'cancelled') {
				throw new SandboxCancelledError({
					...details,
					reason: 'caller',
					completion:
						result.termination === 'unconfirmed'
							? 'unknown'
							: result.termination
				});
			}

			if (result.exit.kind !== 'code') {
				throw new SandboxTransportError(details);
			}

			checkSandboxTargetStatus(result.exit.code, details);

			if (size > sandboxTargetTransferLimit) {
				throw new SandboxOperationError(details, {
					cause: new RangeError('The target helper response exceeds 16 MiB.')
				});
			}

			return Buffer.concat(output);
		},
		identity
	);
}
