import path from 'node:path';

import type {
	BackendFiles,
	BackendProcessContext,
	BackendProcessOutcome,
	SandboxErrorContext
} from 'pi-bring-your-own-sandbox/provider';
import {
	checkSandboxTargetStatus,
	createTargetFileOperations,
	encodePosixArgv,
	SandboxCancelledError,
	SandboxOperationError,
	sandboxTargetTransferLimit,
	SandboxTransportError,
	targetFileHelper
} from 'pi-bring-your-own-sandbox/provider';

type RunFileCommand = (
	command: string,
	context: BackendProcessContext,
	input?: Uint8Array
) => Promise<BackendProcessOutcome>;

export function sandboxFiles(
	workspace: string,
	node: string,
	run: RunFileCommand,
	identity: Omit<SandboxErrorContext, 'operation'>
): BackendFiles {
	let helper: Promise<string> | undefined;

	return createTargetFileOperations(
		async (operation, filename, context, input, requiresWrite) => {
			helper ??= targetFileHelper();

			const command =
				'exec ' +
				encodePosixArgv([
					node,
					'--input-type=module',
					'--eval',
					await helper,
					'--',
					operation,
					path.resolve(workspace, filename),
					String(sandboxTargetTransferLimit),
					requiresWrite ? 'write' : String(input?.byteLength ?? 0)
				]);
			const details = { ...identity, operation };
			const output: Uint8Array[] = [];
			let size = 0;
			const result = await run(
				command,
				{
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
				},
				input
			);

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
					cause: new RangeError('The file response exceeds 16 MiB.')
				});
			}

			return Buffer.concat(output);
		},
		identity
	).files;
}
